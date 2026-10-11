import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
// Development containers share the host checkout; the host owns its hooks.
if (existsSync(".git") && process.env.AIDESK_SKIP_GIT_HOOKS !== "true") {
  const result = spawnSync("lefthook", ["install"], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
