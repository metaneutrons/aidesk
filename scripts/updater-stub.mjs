// A stand-in for the updater of a Compose installation (deploy/updater), for the development stack only. It answers like
// its control API (token, /v1/status, /v1/check, /v1/apply, /v1/config) with a version that never really changes, so that
// the settings page can be worked on and tested without images, signatures or containers to replace. The paths under
// /__stub are for the tests: they reset it and choose how an update ends. They need no token, and the port is published
// to this machine only.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const token = process.env.UPDATER_TOKEN ?? "";
if (token.length < 32) throw new Error("UPDATER_TOKEN must contain at least 32 characters");
const steps = ["verifying", "backing-up", "deploying", "waiting-for-health"];
const initial = () => ({
  state: "available",
  currentVersion: "0.1.0",
  availableVersion: "v0.2.0",
  updateAvailable: true,
  lastCheckedAt: new Date().toISOString(),
  lastUpdatedAt: null,
  lastError: null,
  releaseCheckStatus: "ok",
  releaseCheckError: null,
  releaseCheckRetryAt: null,
  updaterVersion: "0.1.0",
  updaterUpdateAvailable: true,
  updaterSelfUpdateEnabled: true,
  updateMode: "manual",
  maintenanceTime: "02:00",
  timezone: "UTC",
  updaterSwap: null,
  progress: null,
});
let status = initial();
// How the next update ends ("success" or "rollback") and how long each step takes.
let scenario = { outcome: "success", stepMs: 600 };
let timers = [];
const clear = () => {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
};
const at = () => new Date().toISOString();
function progress(phase, extra = {}) {
  const previous = status.progress;
  status.progress = {
    phase,
    detail: null,
    at: at(),
    startedAt: previous?.startedAt ?? at(),
    failedPhase: null,
    rollbackAttempted: false,
    ...extra,
  };
}
function apply() {
  clear();
  status.state = "updating";
  status.lastError = null;
  status.progress = null;
  progress("verifying", { detail: status.availableVersion });
  const wait = scenario.stepMs;
  steps.slice(1).forEach((step, index) => {
    timers.push(setTimeout(() => progress(step), wait * (index + 1)));
  });
  const end = wait * steps.length;
  if (scenario.outcome === "success") {
    timers.push(
      setTimeout(() => {
        progress("done", { detail: status.availableVersion });
        status.currentVersion = status.availableVersion.replace(/^v/, "");
        status.updateAvailable = false;
        status.lastUpdatedAt = at();
        status.state = "current";
      }, end),
    );
  } else {
    timers.push(setTimeout(() => progress("rolling-back", { failedPhase: "waiting-for-health", rollbackAttempted: true }), end));
    timers.push(
      setTimeout(() => {
        progress("failed", {
          detail: "rolled back because the new release did not become ready",
          failedPhase: "waiting-for-health",
          rollbackAttempted: true,
        });
        status.lastError = "rolled back because the new release did not become ready";
        status.state = "failed";
      }, end + wait),
    );
  }
}
const equalToken = (candidate) => {
  const a = Buffer.from(candidate ?? "");
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
const send = (response, code, body) => {
  response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};
const read = (request) =>
  new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
const valid = (value) =>
  value &&
  ["manual", "automatic"].includes(value.mode) &&
  /^([01]\d|2[0-3]):[0-5]\d$/.test(value.maintenanceTime) &&
  typeof value.timezone === "string" &&
  value.timezone.length > 0 &&
  value.timezone.length <= 100;
createServer(async (request, response) => {
  if (request.url?.startsWith("/__stub/")) {
    const input = await read(request);
    if (request.url === "/__stub/reset") {
      clear();
      status = initial();
      scenario = { outcome: "success", stepMs: 600 };
      return send(response, 200, status);
    }
    if (request.url === "/__stub/scenario" && input) {
      scenario = {
        outcome: input.outcome === "rollback" ? "rollback" : "success",
        stepMs: Number.isInteger(input.stepMs) && input.stepMs >= 50 ? input.stepMs : 600,
      };
      return send(response, 200, scenario);
    }
    if (request.url === "/__stub/status" && input) {
      Object.assign(status, input);
      return send(response, 200, status);
    }
    return send(response, 404, { error: "not_found" });
  }
  if (!equalToken(request.headers.authorization?.replace(/^Bearer /, "")))
    return send(response, 401, { error: "unauthorized" });
  const running = status.state === "updating" || status.state === "checking";
  const body = { ...status, progress: status.progress };
  if (request.method === "GET" && request.url === "/v1/status") return send(response, 200, body);
  if (request.method === "POST" && request.url === "/v1/check") {
    if (running) return send(response, 409, { error: "operation_in_progress", status: body });
    const before = status.state;
    status.state = "checking";
    timers.push(
      setTimeout(() => {
        status.state = before === "failed" ? "failed" : status.updateAvailable ? "available" : "current";
        status.lastCheckedAt = at();
      }, 500),
    );
    return send(response, 202, { ...status });
  }
  if (request.method === "POST" && request.url === "/v1/apply") {
    if (running) return send(response, 409, { error: "operation_in_progress", status: body });
    if (!status.updateAvailable) return send(response, 200, body);
    apply();
    return send(response, 202, { ...status });
  }
  if (request.method === "POST" && request.url === "/v1/config") {
    if (running) return send(response, 409, { error: "operation_in_progress", status: body });
    const input = await read(request);
    if (!valid(input)) return send(response, 400, { error: "invalid_config" });
    status.updateMode = input.mode;
    status.maintenanceTime = input.maintenanceTime;
    status.timezone = input.timezone;
    return send(response, 200, status);
  }
  return send(response, 404, { error: "not_found" });
}).listen(8080, "0.0.0.0", () => console.error("updater stub listening on 8080"));
