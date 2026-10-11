import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
if (existsSync(".git")) {
  const result = spawnSync("lefthook", ["install"], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
