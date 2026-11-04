import { z } from "zod";
import type { Principal } from "../domain/permissions";
import { db } from "./db";
import { audit } from "./db/schema";
import { DomainError } from "./errors";
import { env } from "./env";
// The updates of a Compose installation, for the owner. The updater (deploy/updater, profile `updater` of
// compose.production.yaml) finds the latest release, checks the signature of its image, backs up the database, replaces the
// web server and the worker and puts the old image back if the new one does not become ready. This file is the way from
// the settings page to its control API: the page never sees the token, and what the owner starts here is an entry of the
// audit. The product does not know how an update is done; it asks, shows what the updater says and passes on what the
// owner chooses. Where a platform deploys the product itself (Coolify) the updates are made there, by deploying again: the
// installation says so, asks no updater and offers nothing, even when a token is set.
const phases = [
  "verifying",
  "backing-up",
  "deploying",
  "waiting-for-health",
  "done",
  "rolling-back",
  "failed",
] as const;
// The platforms that are recognised as the one that runs the installation. Only Coolify is; another platform is not.
const platforms = ["coolify"] as const;
const progressOut = z.object({
  phase: z.enum(phases),
  detail: z.string().nullable(),
  at: z.string().nullable(),
  startedAt: z.string().nullable(),
  // The step that failed, kept while the rollback runs.
  failedPhase: z.enum(phases).nullable(),
  rollbackAttempted: z.boolean(),
});
export const updaterStatusOut = z.object({
  state: z.enum(["starting", "checking", "current", "available", "updating", "failed"]),
  // Empty for an image that was built on this machine.
  currentVersion: z.string().nullable(),
  availableVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  lastUpdatedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  // Whether the latest release could be asked for; a delayed check keeps the last answer.
  releaseCheckStatus: z.enum(["ok", "degraded"]),
  releaseCheckError: z.string().nullable(),
  releaseCheckRetryAt: z.string().nullable(),
  updaterVersion: z.string().nullable(),
  updaterUpdateAvailable: z.boolean(),
  updaterSelfUpdateEnabled: z.boolean(),
  // The platform that the updater found to run the containers, which then refuses to work; an updater that does not look
  // reports none.
  managedBy: z.enum(platforms).nullable().default(null),
  updateMode: z.enum(["manual", "automatic"]),
  maintenanceTime: z.string(),
  timezone: z.string(),
  // How the last replacement of the updater itself ended.
  updaterSwap: z
    .object({
      outcome: z.enum(["succeeded", "failed", "rolled-back"]),
      detail: z.string().nullable(),
      at: z.string().nullable(),
    })
    .nullable(),
  progress: progressOut.nullable(),
});
export const updatesOut = z.object({
  // Without a token there is no updater; the others say what the product found when it asked.
  // `not-configured` is also what a platform that runs the installation itself gets: no updater is asked.
  availability: z.enum(["not-configured", "unreachable", "unauthorized", "ok"]),
  status: updaterStatusOut.nullable(),
  // The platform that deploys this installation, so that it is updated there: found by the product (environment of the
  // application) or reported by the updater (labels of the containers). Then there is nothing to check, install or schedule.
  managedBy: z.enum(platforms).nullable(),
});
export type Updates = z.infer<typeof updatesOut>;
const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};
export const scheduleInput = z
  .object({
    mode: z.enum(["manual", "automatic"]),
    maintenanceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(100).refine(validTimezone),
  })
  .strict();
const owner = (principal: Principal) => {
  if (principal.kind !== "human" || !principal.active || !principal.owner)
    throw new DomainError("forbidden", 403);
};
type Answer =
  | { kind: "answered"; code: number; body: unknown }
  | { kind: "unauthorized" }
  | { kind: "unreachable" };
// One request to the control API. A redirect is refused, so that the token goes to the updater and nowhere else.
async function call(path: string, method: "GET" | "POST", body?: unknown): Promise<Answer> {
  const { UPDATER_URL, UPDATER_TOKEN } = env();
  try {
    const response = await fetch(new URL(path, UPDATER_URL), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${UPDATER_TOKEN ?? ""}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) return { kind: "unauthorized" };
    return {
      kind: "answered",
      code: response.status,
      body: await response.json().catch(() => null),
    };
  } catch {
    return { kind: "unreachable" };
  }
}
const configured = () => env().UPDATER_TOKEN !== undefined;
// Coolify puts the uuid of the application into the environment of its containers. Nothing else is a sign of it here.
const platform = (): Updates["managedBy"] =>
  env().COOLIFY_RESOURCE_UUID === undefined ? null : "coolify";
const none = (
  availability: Updates["availability"],
  managedBy: Updates["managedBy"] = null,
): Updates => ({
  availability,
  status: null,
  managedBy,
});
// The status in an answer: a request that was refused because another operation runs carries it as well.
function statusOf(answer: Answer): Updates {
  if (answer.kind === "unauthorized") return none("unauthorized");
  if (answer.kind === "unreachable") return none("unreachable");
  const body = answer.body as { status?: unknown } | null;
  const parsed = updaterStatusOut.safeParse(
    answer.code === 409 && body && typeof body === "object" && "status" in body
      ? body.status
      : body,
  );
  // An answer that is not the control API's (another service at the address) counts as no answer.
  return parsed.success
    ? { availability: "ok", status: parsed.data, managedBy: parsed.data.managedBy }
    : none("unreachable");
}
const record = (principal: Principal, action: string, detail: Record<string, unknown>) =>
  db().insert(audit).values({
    projectId: null,
    actorId: principal.id,
    action,
    targetId: "workspace",
    detail,
  });
export async function updateStatus(principal: Principal): Promise<Updates> {
  owner(principal);
  if (platform()) return none("not-configured", platform());
  if (!configured()) return none("not-configured");
  return statusOf(await call("/v1/status", "GET"));
}
// Asks the updater to look at the releases now; the result is read with the next status.
export async function checkUpdates(principal: Principal): Promise<Updates> {
  owner(principal);
  if (platform()) return none("not-configured", platform());
  if (!configured()) return none("not-configured");
  return statusOf(await call("/v1/check", "POST"));
}
// Starts the update to the release that the updater found. Only the owner, and only when the updater says that a release is
// waiting and nothing else is running: the version is the updater's to name, so that the page cannot ask for another one.
export async function applyUpdate(principal: Principal): Promise<Updates> {
  owner(principal);
  if (platform() || !configured()) throw new DomainError("conflict", 409);
  const now = statusOf(await call("/v1/status", "GET"));
  if (now.status === null) throw new DomainError("source_unavailable", 502);
  if (now.status.managedBy !== null) throw new DomainError("conflict", 409);
  if (!now.status.updateAvailable || ["updating", "checking"].includes(now.status.state))
    throw new DomainError("conflict", 409);
  const answer = await call("/v1/apply", "POST");
  if (answer.kind !== "answered") throw new DomainError("source_unavailable", 502);
  if (answer.code === 409) throw new DomainError("conflict", 409);
  if (answer.code !== 202) throw new DomainError("source_unavailable", 502);
  await record(principal, "updates.apply", {
    from: now.status.currentVersion,
    to: now.status.availableVersion,
  });
  return statusOf(answer);
}
// The maintenance window: whether an update that is waiting is installed by itself, and when. Not while an operation runs.
export async function setUpdateSchedule(principal: Principal, input: unknown): Promise<Updates> {
  owner(principal);
  const values = scheduleInput.parse(input);
  if (platform() || !configured()) throw new DomainError("conflict", 409);
  const answer = await call("/v1/config", "POST", values);
  if (answer.kind !== "answered") throw new DomainError("source_unavailable", 502);
  if (answer.code === 409) throw new DomainError("conflict", 409);
  if (answer.code === 400) throw new DomainError("invalid_input", 400);
  if (answer.code !== 200) throw new DomainError("source_unavailable", 502);
  await record(principal, "updates.schedule", values);
  return statusOf(answer);
}
