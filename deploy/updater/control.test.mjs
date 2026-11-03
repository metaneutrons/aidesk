// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

process.env.AIDESK_UPDATER_TEST = "true";
process.env.UPDATER_TOKEN = "a".repeat(64);
const testDirectory = mkdtempSync(join(tmpdir(), "aidesk-updater-control-"));
const progressFile = join(testDirectory, "progress.json");
process.env.PROGRESS_FILE = progressFile;
process.env.CONTROL_PORT = "0";
// A `docker` that answers from the environment, so that the real control API and the real commands run without a daemon. It
// writes down every call, which shows what was and was not asked of the daemon.
const dockerLog = join(testDirectory, "docker.log");
writeFileSync(
  join(testDirectory, "docker"),
  `#!/bin/sh
printf '%s\\n' "$*" >>"${dockerLog}"
case "$1" in
  inspect) case "$*" in *coolify.managed*) printf '%s\\n' "$FAKE_OWN_LABEL" ;; esac ;;
  ps) case "$*" in *--format*coolify.managed*) printf '%s\\n' "$FAKE_PROJECT_LABELS" ;; *--format*) ;; *) printf 'abc123\\n' ;; esac ;;
esac
`
);
chmodSync(join(testDirectory, "docker"), 0o755);
process.env.PATH = `${testDirectory}:${process.env.PATH}`;
after(() => rmSync(testDirectory, { recursive: true, force: true }));
const {
  apply,
  check,
  detectManagedBy,
  equalToken,
  fetchReleaseVersion,
  latestReleaseTag,
  newer,
  publicStatus,
  reached,
  releaseDecision,
  retryAtFromHeaders,
  startProgressJournal,
  startServer,
  status,
  validateConfig,
  zonedClock,
} = await import("./control.mjs");

test("resets a completed journal synchronously when a new update starts", () => {
  writeFileSync(
    progressFile,
    JSON.stringify({
      phase: "done",
      detail: null,
      at: "2026-08-15T08:00:10.000Z",
      startedAt: "2026-08-15T08:00:00.000Z",
    })
  );

  assert.equal(startProgressJournal("v1.12.0", new Date("2026-08-16T09:00:00.000Z")), true);
  assert.deepEqual(JSON.parse(readFileSync(progressFile, "utf8")), {
    phase: "verifying",
    detail: "v1.12.0",
    at: "2026-08-16T09:00:00.000Z",
    startedAt: "2026-08-16T09:00:00.000Z",
    failedPhase: null,
    rollbackAttempted: false,
  });
});

test("compares versions with and without the v and never offers a downgrade", () => {
  // The label of the image carries no v, the tag of the release does.
  assert.equal(newer("1.8.1", "v1.8.2"), true);
  assert.equal(newer("v1.9.9", "v2.0.0"), true);
  assert.equal(newer("2.0.0", "v1.99.99"), false);
  assert.equal(newer("1.8.2", "v1.8.2"), false);
  assert.equal(newer("v1.8.2", "1.8.2"), false);
  assert.equal(newer("v1.8.2", "not-a-version"), false);
});

test("treats an unknown own version as older than any release", () => {
  // An image built on this machine has no version label, a development build has 0.0.0-dev.
  assert.equal(newer(null, "v1.9.6"), true);
  assert.equal(newer("", "v1.9.6"), true);
  assert.equal(newer("0.0.0-dev", "v1.9.6"), true);
  assert.equal(newer("1.9.7", "v1.9.6"), false);
});

test("confirms an update only from the version actually running", () => {
  assert.equal(reached("1.10.5", "v1.10.5"), true);
  assert.equal(reached("1.10.6", "v1.10.5"), true);
  assert.equal(reached("1.10.4", "v1.10.5"), false);
  assert.equal(reached(null, "v1.10.5"), false);
  assert.equal(reached("", "v1.10.5"), false);
});

test("offers a newer release and none that is current", () => {
  assert.deepEqual(releaseDecision("1.10.3", "v1.10.4"), {
    state: "available",
    updateAvailable: true,
  });
  assert.deepEqual(releaseDecision("1.10.4", "v1.10.4"), {
    state: "current",
    updateAvailable: false,
  });
  assert.deepEqual(releaseDecision("1.10.5", "v1.10.4"), {
    state: "current",
    updateAvailable: false,
  });
});

test("requires an exact control token", () => {
  assert.equal(equalToken("a".repeat(64)), true);
  assert.equal(equalToken("a".repeat(63)), false);
  assert.equal(equalToken("b".repeat(64)), false);
  assert.equal(equalToken(undefined), false);
});

test("validates and evaluates timezone-aware maintenance schedules", () => {
  assert.equal(
    validateConfig({ mode: "automatic", maintenanceTime: "02:30", timezone: "Europe/Berlin" }),
    true
  );
  assert.equal(validateConfig({ mode: "manual", maintenanceTime: "23:59", timezone: "UTC" }), true);
  assert.equal(
    validateConfig({ mode: "automatic", maintenanceTime: "24:00", timezone: "UTC" }),
    false
  );
  assert.equal(
    validateConfig({ mode: "automatic", maintenanceTime: "02:30", timezone: "Not/AZone" }),
    false
  );
  assert.equal(validateConfig({ mode: "sometimes", maintenanceTime: "02:30", timezone: "UTC" }), false);
  assert.equal(validateConfig(null), false);
  assert.deepEqual(zonedClock(new Date("2026-08-11T00:30:00Z"), "Europe/Berlin"), {
    date: "2026-08-11",
    time: "02:30",
  });
});

test("reports its own version and starts as a manual updater", () => {
  const status = publicStatus();
  assert.ok("updaterVersion" in status, "status must always carry updaterVersion");
  assert.equal(status.releaseCheckStatus, "ok");
  assert.equal(status.releaseCheckError, null);
  assert.equal(status.updaterSelfUpdateEnabled, true);
  assert.equal(status.updaterUpdateAvailable, false, "must not claim an update before a check ran");
  // Nothing is installed without the owner asking for it, unless AUTO_APPLY is set.
  assert.equal(status.updateMode, "manual");
});

test("selects the newest stable release and ignores drafts and prereleases", () => {
  assert.equal(
    latestReleaseTag([
      { tag_name: "v1.10.1", draft: false, prerelease: false },
      { tag_name: "v1.10.2", draft: false, prerelease: false },
      { tag_name: "v2.0.0", draft: false, prerelease: true },
      { tag_name: "v9.0.0", draft: true, prerelease: false },
      { tag_name: "nightly", draft: false, prerelease: false },
    ]),
    "v1.10.2"
  );
  assert.equal(latestReleaseTag([{ tag_name: "v1.0.0", draft: true, prerelease: false }]), null);
  // The single-release endpoint returns an object.
  assert.equal(latestReleaseTag({ tag_name: "v1.10.2", draft: false, prerelease: false }), "v1.10.2");
});

test("retries transient GitHub failures and accepts the next valid release", async () => {
  const responses = [
    new Response("gateway timeout", { status: 504 }),
    Response.json({ tag_name: "v1.13.0", draft: false, prerelease: false }),
  ];
  const delays = [];
  const tag = await fetchReleaseVersion(
    "https://example.test/releases/latest",
    async () => responses.shift(),
    async (delay) => delays.push(delay)
  );
  assert.equal(tag, "v1.13.0");
  assert.deepEqual(delays, [500]);
});

test("rejects an implausibly empty release response after bounded retries", async () => {
  let attempts = 0;
  await assert.rejects(
    fetchReleaseVersion(
      "https://example.test/releases/latest",
      async () => {
        attempts += 1;
        return Response.json([]);
      },
      async () => {}
    ),
    (error) => error?.code === "invalid-response"
  );
  assert.equal(attempts, 3);
});

test("honors GitHub rate-limit reset metadata without busy retrying", async () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const retryAt = retryAtFromHeaders(
    new Headers({ "retry-after": "120", "x-ratelimit-reset": "1" }),
    now
  );
  assert.equal(retryAt, "2026-08-17T12:02:00.000Z");
  let attempts = 0;
  await assert.rejects(
    fetchReleaseVersion(
      "https://example.test/releases/latest",
      async () => {
        attempts += 1;
        return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      },
      async () => {},
      () => now
    ),
    (error) => error?.code === "rate-limited" && error?.retryAt === retryAt
  );
  assert.equal(attempts, 1);
});

// Coolify labels every container of an application with coolify.managed=true and names the Compose project after the
// application. The labels are the answer of the daemon; what is asked, and what is made of the answer, is tested here.
test("recognises Coolify by the label of the own container or of a container of the project", async () => {
  const asked = [];
  const answers = (own, project) => async (_name, args) => {
    asked.push(args);
    return args[0] === "inspect" ? own : project;
  };
  assert.equal(await detectManagedBy(answers("true", "")), "coolify");
  assert.equal(await detectManagedBy(answers("", "true\ntrue")), "coolify");
  assert.equal(await detectManagedBy(answers("", "\ntrue")), "coolify");
  // No labels, other values, and a label of something else: not managed.
  assert.equal(await detectManagedBy(answers("", "")), null);
  assert.equal(await detectManagedBy(answers("false", "\n\n")), null);
  assert.equal(await detectManagedBy(answers("", "truely")), null);
  // A daemon that cannot be asked is not a sign of Coolify.
  assert.equal(
    await detectManagedBy(async () => {
      throw new Error("no daemon");
    }),
    null
  );
  // Only the project of the installation is asked about, never the whole host.
  assert.ok(asked.some((args) => args[0] === "inspect" && args.join(" ").includes("coolify.managed")));
  const lists = asked.filter((args) => args[0] === "ps");
  for (const args of lists) assert.ok(args.join(" ").includes("coolify.managed"));
  assert.ok(lists.length > 0);
  for (const args of lists) assert.ok(args.includes("label=com.docker.compose.project=aidesk"));
});

test("refuses to check and to install under Coolify without asking for a release or touching a container", async () => {
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error("the release API must not be asked");
  };
  try {
    writeFileSync(dockerLog, "");
    rmSync(progressFile, { force: true });
    process.env.FAKE_OWN_LABEL = "";
    process.env.FAKE_PROJECT_LABELS = "true\ntrue";
    await check();
    assert.equal(status.managedBy, "coolify");
    assert.equal(status.state, "failed");
    assert.equal(status.updateAvailable, false);
    assert.match(status.lastError, /Coolify/);
    assert.equal(publicStatus().managedBy, "coolify");
    // An update that was possible before the labels were seen is refused when it is started.
    Object.assign(status, {
      state: "available",
      updateAvailable: true,
      availableVersion: "v9.9.9",
      lastError: null,
      managedBy: null,
    });
    assert.equal(await apply(), true);
    assert.equal(status.state, "failed");
    assert.equal(status.managedBy, "coolify");
    assert.match(status.lastError, /Coolify/);
    assert.deepEqual(requests, []);
    // Only labels were read: no image, no exec, no compose.
    const calls = readFileSync(dockerLog, "utf8").trim().split("\n");
    assert.ok(calls.every((call) => /^(inspect|ps) /.test(call)), calls.join("\n"));
    // No journal of an update was started.
    assert.throws(() => readFileSync(progressFile, "utf8"), { code: "ENOENT" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("lets an installation without the labels through to the release check and the update", async () => {
  process.env.FAKE_OWN_LABEL = "";
  process.env.FAKE_PROJECT_LABELS = "";
  Object.assign(status, {
    state: "available",
    updateAvailable: true,
    availableVersion: "v9.9.9",
    lastError: null,
    managedBy: "coolify",
  });
  // The command of the worker does not exist here, so the update fails for its own reason, not for Coolify.
  assert.equal(await apply(), true);
  assert.equal(status.state, "failed");
  assert.doesNotMatch(status.lastError ?? "", /Coolify/);
  assert.equal(JSON.parse(readFileSync(progressFile, "utf8")).phase, "verifying");
});

test("answers the control API with managedBy and refuses to install or to schedule under Coolify", async () => {
  process.env.FAKE_OWN_LABEL = "true";
  process.env.FAKE_PROJECT_LABELS = "";
  const server = startServer();
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = (path, method = "GET", body) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    await check();
    const reported = await (await ask("/v1/status")).json();
    assert.equal(reported.managedBy, "coolify");
    assert.match(reported.lastError, /Coolify/);
    writeFileSync(dockerLog, "");
    const apply = await ask("/v1/apply", "POST");
    assert.equal(apply.status, 409);
    assert.equal((await apply.json()).error, "managed_by_platform");
    const schedule = await ask("/v1/config", "POST", {
      mode: "automatic",
      maintenanceTime: "03:00",
      timezone: "UTC",
    });
    assert.equal(schedule.status, 409);
    assert.equal(readFileSync(dockerLog, "utf8"), "");
    // Not without the token.
    assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
