// SPDX-License-Identifier: GPL-3.0-or-later
// The control API of the updater: finds the latest release, keeps the maintenance window and
// starts update.sh for one update. The settings page of the product talks to it (owner only);
// it is reachable inside the Compose network only and needs the token.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const token = process.env.UPDATER_TOKEN ?? "";
const intervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? 3600);
const operationTimeoutMs = Number(process.env.UPDATE_TIMEOUT_SECONDS ?? 900) * 1000;
const port = Number(process.env.CONTROL_PORT ?? 8080);
const releaseApi =
  process.env.RELEASE_API ?? "https://api.github.com/repos/metaneutrons/aidesk/releases/latest";
const composeProject = process.env.COMPOSE_PROJECT ?? "aidesk";
const appService = process.env.APP_SERVICE ?? "app";
// Own image version, baked in at build time (Dockerfile ARG UPDATER_VERSION).
const updaterVersion = (process.env.UPDATER_VERSION ?? "").trim() || null;
const updaterSelfUpdateEnabled = (process.env.AUTO_UPDATE_UPDATER ?? "true") === "true";
const swapResultFile = process.env.SWAP_RESULT_FILE ?? "/state/updater-swap.json";
const progressFile = process.env.PROGRESS_FILE ?? "/state/updater-progress.json";

// The outcome of the last self-update was written by the helper that did it. That container
// is gone by the time anyone asks, so the new updater reports it.
function lastSwap() {
  try {
    const value = JSON.parse(readFileSync(swapResultFile, "utf8"));
    if (!value || !["succeeded", "failed", "rolled-back"].includes(value.outcome)) return null;
    return {
      outcome: value.outcome,
      detail: typeof value.detail === "string" ? value.detail.slice(0, 300) : null,
      at: typeof value.at === "string" ? value.at : null,
    };
  } catch {
    return null;
  }
}

const configFile = process.env.UPDATER_CONFIG_FILE ?? "/state/config.json";
const defaultConfig = {
  mode: (process.env.AUTO_APPLY ?? "false") === "true" ? "automatic" : "manual",
  maintenanceTime: process.env.MAINTENANCE_TIME ?? "02:00",
  timezone: process.env.TZ ?? "UTC",
  lastAutomaticAttemptDate: null,
};

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
function validateConfig(value) {
  return Boolean(
    value &&
      ["manual", "automatic"].includes(value.mode) &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(value.maintenanceTime) &&
      typeof value.timezone === "string" &&
      value.timezone.length <= 100 &&
      validTimezone(value.timezone) &&
      (value.lastAutomaticAttemptDate == null ||
        /^\d{4}-\d{2}-\d{2}$/.test(value.lastAutomaticAttemptDate))
  );
}
if (process.env.AIDESK_UPDATER_TEST !== "true") {
  if (token.length < 32) throw new Error("UPDATER_TOKEN must contain at least 32 characters");
  // The control API is root-equivalent through the Docker socket; a token that is published in
  // an example file must not guard it.
  if (/replace[-_]with|change[-_]?me/i.test(token)) {
    throw new Error(
      "UPDATER_TOKEN still contains the example placeholder, generate one with: openssl rand -hex 32"
    );
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 300)
    throw new Error("POLL_INTERVAL_SECONDS must be at least 300");
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 60_000)
    throw new Error("UPDATE_TIMEOUT_SECONDS must be at least 60");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("CONTROL_PORT is invalid");
  if (!validateConfig(defaultConfig)) throw new Error("invalid default update schedule");
}

function loadConfig() {
  try {
    const stored = JSON.parse(readFileSync(configFile, "utf8"));
    if (validateConfig(stored)) return { ...defaultConfig, ...stored };
    console.error("aidesk-updater: ignoring invalid persisted configuration");
  } catch (error) {
    if (error?.code !== "ENOENT")
      console.error(`aidesk-updater: cannot read persisted configuration: ${error}`);
  }
  return { ...defaultConfig };
}
let config = loadConfig();
function saveConfig() {
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  renameSync(temporary, configFile);
}

const status = {
  state: "starting",
  currentVersion: null,
  availableVersion: null,
  updateAvailable: false,
  lastCheckedAt: null,
  lastCheckAttemptAt: null,
  lastUpdatedAt: null,
  lastError: null,
  releaseCheckStatus: "ok",
  releaseCheckError: null,
  releaseCheckRetryAt: null,
  updaterVersion,
  updaterUpdateAvailable: false,
  updaterSelfUpdateEnabled,
};
let active = false;

const PHASES = [
  "verifying",
  "backing-up",
  "deploying",
  "waiting-for-health",
  "done",
  "rolling-back",
  "failed",
];
// The journal written by update.sh. The product is the thing being replaced, so it cannot
// report its own restart: this is the only progress the settings page can show meanwhile.
function lastProgress() {
  try {
    const value = JSON.parse(readFileSync(progressFile, "utf8"));
    if (!value || !PHASES.includes(value.phase)) return null;
    return {
      phase: value.phase,
      detail: typeof value.detail === "string" ? value.detail.slice(0, 200) : null,
      at: typeof value.at === "string" ? value.at : null,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
      failedPhase: PHASES.includes(value.failedPhase) ? value.failedPhase : null,
      rollbackAttempted: value.rollbackAttempted === true,
    };
  } catch {
    return null;
  }
}

// Published before /v1/apply answers. Otherwise the first poll of the page can still read the
// journal of the previous update while the worker is only starting.
function startProgressJournal(targetVersion, now = new Date()) {
  const at = now.toISOString();
  const temporary = `${progressFile}.tmp`;
  try {
    mkdirSync(dirname(progressFile), { recursive: true, mode: 0o700 });
    writeFileSync(
      temporary,
      `${JSON.stringify({
        phase: "verifying",
        detail: targetVersion || null,
        at,
        startedAt: at,
        failedPhase: null,
        rollbackAttempted: false,
      })}\n`,
      { mode: 0o600 }
    );
    renameSync(temporary, progressFile);
    return true;
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Cleaning up the journal is advisory too; it never blocks the update.
    }
    console.error(`aidesk-updater: cannot reset progress journal: ${error}`);
    return false;
  }
}

function publicStatus() {
  return {
    ...status,
    updateMode: config.mode,
    maintenanceTime: config.maintenanceTime,
    timezone: config.timezone,
    updaterSwap: lastSwap(),
    progress: lastProgress(),
  };
}
function equalToken(candidate) {
  const a = Buffer.from(candidate ?? "");
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function parts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}
// An unknown own version (an image built on this machine, a development build) is older than
// any release.
function newer(current, candidate) {
  const a = parts(current);
  const b = parts(candidate);
  if (!b) return false;
  if (!a) return true;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] > a[i];
  }
  return false;
}
function reached(current, targetVersion) {
  const currentParts = parts(current);
  const targetParts = parts(targetVersion);
  if (!currentParts || !targetParts) return false;
  for (let i = 0; i < 3; i++) {
    if (currentParts[i] !== targetParts[i]) return currentParts[i] > targetParts[i];
  }
  return true;
}
function releaseDecision(current, available) {
  const releaseIsNewer = newer(current, available);
  return { state: releaseIsNewer ? "available" : "current", updateAvailable: releaseIsNewer };
}
function latestReleaseTag(payload) {
  const releases = Array.isArray(payload) ? payload : [payload];
  return (
    releases
      .filter(
        (release) =>
          release &&
          release.draft === false &&
          release.prerelease === false &&
          /^v\d+\.\d+\.\d+$/.test(release.tag_name ?? "")
      )
      .map((release) => release.tag_name)
      .sort((left, right) => {
        const a = parts(left);
        const b = parts(right);
        for (let i = 0; i < 3; i++) {
          if (a[i] !== b[i]) return b[i] - a[i];
        }
        return 0;
      })[0] ?? null
  );
}
function zonedClock(date, timezone) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}
function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { quietStderr = false, ...spawnOptions } = options;
    const child = spawn(commandName, args, {
      timeout: operationTimeoutMs,
      killSignal: "SIGTERM",
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (!quietStderr) process.stderr.write(data);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(stderr.trim() || `${commandName} exited ${code}`))
    );
  });
}
// The version label of the image the web server runs from. Empty for an image built here.
async function currentVersion() {
  const container = (
    await command("docker", [
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--filter",
      `label=com.docker.compose.service=${appService}`,
    ])
  ).split("\n")[0];
  if (!container) throw new Error("the web server is not running");
  const image = await command("docker", ["inspect", "--format", "{{.Image}}", container]);
  return command("docker", [
    "image",
    "inspect",
    "--format",
    '{{ index .Config.Labels "org.opencontainers.image.version" }}',
    image,
  ]);
}
const RELEASE_CHECK_ATTEMPTS = 3;
const RELEASE_CHECK_DELAYS_MS = [500, 1_500];
const INLINE_RATE_LIMIT_WAIT_MS = 5_000;

class ReleaseCheckError extends Error {
  constructor(code, message, retryAt = null) {
    super(message);
    this.name = "ReleaseCheckError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAtFromHeaders(headers, now = Date.now()) {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0)
    return new Date(now + retryAfter * 1_000).toISOString();
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1_000).toISOString();
  return null;
}

function releaseCheckError(error) {
  if (error instanceof ReleaseCheckError) return error;
  const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
  return new ReleaseCheckError(
    timeout ? "upstream-timeout" : "network-error",
    timeout ? "GitHub Releases request timed out" : "GitHub Releases request failed"
  );
}

async function fetchReleaseVersion(
  api = releaseApi,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = () => Date.now()
) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "aidesk-updater" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let lastError = null;
  for (let attempt = 0; attempt < RELEASE_CHECK_ATTEMPTS; attempt += 1) {
    let retryDelay = RELEASE_CHECK_DELAYS_MS[attempt] ?? 0;
    try {
      const response = await fetchImpl(api, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const tag = latestReleaseTag(payload);
        if (tag) return tag;
        lastError = new ReleaseCheckError(
          "invalid-response",
          "GitHub Releases returned no stable release"
        );
      } else if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      ) {
        const retryAt = retryAtFromHeaders(response.headers, now());
        lastError = new ReleaseCheckError(
          "rate-limited",
          `GitHub Releases rate limit returned HTTP ${response.status}`,
          retryAt
        );
        const wait = retryAt ? new Date(retryAt).getTime() - now() : Infinity;
        if (wait > INLINE_RATE_LIMIT_WAIT_MS) throw lastError;
        retryDelay = Math.max(retryDelay, wait);
      } else if (response.status === 408 || response.status === 425 || response.status >= 500) {
        lastError = new ReleaseCheckError(
          "upstream-unavailable",
          `GitHub Releases temporarily returned HTTP ${response.status}`
        );
      } else {
        throw new ReleaseCheckError(
          "request-rejected",
          `GitHub Releases returned HTTP ${response.status}`
        );
      }
    } catch (error) {
      lastError = releaseCheckError(error);
      if (["rate-limited", "request-rejected"].includes(lastError.code)) throw lastError;
    }
    if (attempt < RELEASE_CHECK_ATTEMPTS - 1) await sleepImpl(retryDelay);
  }
  throw lastError ?? new ReleaseCheckError("network-error", "GitHub Releases request failed");
}

let releaseCheckRetryTimer = null;
let releaseCheckRetryAttempt = 0;
function clearReleaseCheckRetry() {
  if (releaseCheckRetryTimer) clearTimeout(releaseCheckRetryTimer);
  releaseCheckRetryTimer = null;
  releaseCheckRetryAttempt = 0;
  status.releaseCheckRetryAt = null;
}
function scheduleReleaseCheckRetry(requestedRetryAt = null) {
  if (releaseCheckRetryTimer) clearTimeout(releaseCheckRetryTimer);
  const fallbackDelay = Math.min(30 * 2 ** releaseCheckRetryAttempt, 300) * 1_000;
  const requestedDelay = requestedRetryAt
    ? Math.max(new Date(requestedRetryAt).getTime() - Date.now(), 0)
    : 0;
  const delay = Math.max(fallbackDelay, requestedDelay);
  releaseCheckRetryAttempt += 1;
  status.releaseCheckRetryAt = new Date(Date.now() + delay).toISOString();
  releaseCheckRetryTimer = setTimeout(() => {
    releaseCheckRetryTimer = null;
    void check();
  }, delay);
  releaseCheckRetryTimer.unref();
}
async function check() {
  if (active) return;
  active = true;
  const previousState = status.state;
  status.state = "checking";
  status.lastCheckAttemptAt = new Date().toISOString();
  try {
    const [current, available] = await Promise.all([currentVersion(), fetchReleaseVersion()]);
    status.lastError = null;
    status.currentVersion = current || null;
    status.availableVersion = available;
    status.lastCheckedAt = new Date().toISOString();
    status.releaseCheckStatus = "ok";
    status.releaseCheckError = null;
    clearReleaseCheckRetry();
    const decision = releaseDecision(current, available);
    status.updateAvailable = decision.updateAvailable;
    // Both images carry the version of the release, so the release is also the updater's.
    status.updaterUpdateAvailable = newer(updaterVersion, available);
    const progress = lastProgress();
    // A periodic check must not erase the outcome of a failed update while the old version
    // still runs: retry stays possible, and the reason stays visible.
    if (decision.updateAvailable && ["failed", "rolling-back"].includes(progress?.phase)) {
      status.state = "failed";
      status.lastError = progress?.detail ?? "The previous update attempt failed";
    } else {
      status.state = decision.state;
    }
  } catch (error) {
    if (error instanceof ReleaseCheckError) {
      status.state = ["available", "current", "failed"].includes(previousState)
        ? previousState
        : "current";
      status.releaseCheckStatus = "degraded";
      status.releaseCheckError = error.code;
      scheduleReleaseCheckRetry(error.retryAt);
      console.error(`aidesk-updater: release check degraded: ${error.message}`);
    } else {
      clearReleaseCheckRetry();
      status.state = "failed";
      status.lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
    }
  } finally {
    active = false;
  }
  await tryScheduledApply();
}
async function apply() {
  if (active) return false;
  active = true;
  status.state = "updating";
  status.lastError = null;
  try {
    const targetVersion = status.availableVersion;
    startProgressJournal(targetVersion);
    // The release was resolved and checked above. The worker is given exactly that one, so an
    // outage of the GitHub API cannot break an update the owner has already started.
    await command("/usr/local/bin/aidesk-update", [], {
      env: { ...process.env, UPDATE_ONCE: "true", TARGET_VERSION: targetVersion },
    });
    const runningVersion = await currentVersion();
    if (!reached(runningVersion, targetVersion)) {
      throw new Error(
        `update command completed but ${runningVersion || "no version"} is running instead of ${targetVersion || "the requested release"}`
      );
    }
    status.currentVersion = runningVersion;
    status.updateAvailable = false;
    status.lastUpdatedAt = new Date().toISOString();
    status.state = "current";
  } catch (error) {
    const progress = lastProgress();
    status.state = "failed";
    status.lastError =
      progress?.detail ?? String(error instanceof Error ? error.message : error).slice(-500);
  } finally {
    active = false;
  }
  return true;
}
async function tryScheduledApply(now = new Date()) {
  if (active || !status.updateAvailable || config.mode !== "automatic") return false;
  const clock = zonedClock(now, config.timezone);
  if (clock.time !== config.maintenanceTime || clock.date === config.lastAutomaticAttemptDate)
    return false;
  config.lastAutomaticAttemptDate = clock.date;
  saveConfig();
  return apply();
}
function send(response, code, body) {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}
function startServer() {
  return createServer(async (request, response) => {
    try {
      if (!equalToken(request.headers.authorization?.replace(/^Bearer /, "")))
        return send(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && request.url === "/v1/status")
        return send(response, 200, publicStatus());
      if (request.method === "POST" && request.url === "/v1/check") {
        if (active)
          return send(response, 409, { error: "operation_in_progress", status: publicStatus() });
        void check();
        return send(response, 202, publicStatus());
      }
      if (request.method === "POST" && request.url === "/v1/apply") {
        if (active)
          return send(response, 409, { error: "operation_in_progress", status: publicStatus() });
        if (!status.updateAvailable) return send(response, 200, publicStatus());
        void apply();
        return send(response, 202, publicStatus());
      }
      if (request.method === "POST" && request.url === "/v1/config") {
        if (active)
          return send(response, 409, { error: "operation_in_progress", status: publicStatus() });
        const input = await readJson(request);
        if (!validateConfig(input)) return send(response, 400, { error: "invalid_config" });
        config = {
          mode: input.mode,
          maintenanceTime: input.maintenanceTime,
          timezone: input.timezone,
          lastAutomaticAttemptDate: null,
        };
        saveConfig();
        void tryScheduledApply();
        return send(response, 200, publicStatus());
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      console.error(`aidesk-updater: control request failed: ${error}`);
      if (!response.headersSent) return send(response, 400, { error: "invalid_request" });
    }
  }).listen(port, "0.0.0.0", () =>
    console.error(`aidesk-updater: control API listening on ${port}`)
  );
}

if (process.env.AIDESK_UPDATER_TEST !== "true") {
  const server = startServer();
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  void check();
  setInterval(() => void check(), intervalSeconds * 1000).unref();
  setInterval(() => void tryScheduledApply(), 30_000).unref();
}

export {
  equalToken,
  fetchReleaseVersion,
  latestReleaseTag,
  newer,
  publicStatus,
  reached,
  releaseDecision,
  retryAtFromHeaders,
  startProgressJournal,
  validateConfig,
  zonedClock,
};
