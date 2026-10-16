import { githubConfig, githubSecret } from "../domain/connections";
import { unseal } from "./crypto";
import type { connections } from "./db/schema";
import { env } from "./env";
import { checkHost } from "./host-guard";
// The one place that talks to the API of GitHub for a connection of a project. A request has a
// time limit, does not follow a redirect (it would take the token to another host) and checks the
// host again. What comes back is a status and the parsed body; a request that did not complete is
// told apart from one that GitHub refused, because a write whose outcome is unknown must not be
// repeated.
export type GithubConnection = typeof connections.$inferSelect;
export interface GithubDeps {
  fetch?: typeof fetch;
}
export type GithubResult =
  | { kind: "answer"; status: number; json: unknown }
  // The request may have reached GitHub, or did not: nothing is known about its effect.
  | { kind: "unknown"; code: "timeout" | "unreachable" | "host_refused" | "bad_response" };
const waitMs = 10_000;
export async function githubRequest(
  row: GithubConnection,
  call: { method: "GET" | "POST"; path: string; body?: unknown },
  deps: GithubDeps = {},
): Promise<GithubResult> {
  const config = githubConfig.parse(row.config);
  const secret = githubSecret.parse(
    JSON.parse(unseal(row.secretCiphertext ?? "", env().ENCRYPTION_KEY)),
  );
  const url = `${(config.endpoint ?? "https://api.github.com").replace(/\/+$/, "")}${call.path}`;
  if (!config.developmentOnly && (await checkHost(new URL(url).hostname)) !== "allowed")
    return { kind: "unknown", code: "host_refused" };
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${secret.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "aidesk",
        ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(waitMs),
    });
    const text = await response.text();
    try {
      return {
        kind: "answer",
        status: response.status,
        json: text ? (JSON.parse(text) as unknown) : null,
      };
    } catch {
      // A status was given but the body is not what the API sends: only a failure that is not 2xx is clear.
      return response.ok
        ? { kind: "unknown", code: "bad_response" }
        : { kind: "answer", status: response.status, json: null };
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      kind: "unknown",
      code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable",
    };
  }
}
