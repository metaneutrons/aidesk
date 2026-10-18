import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const target = `src/domain/gate-counter-${randomUUID()}.ts`;
const run = (args) => spawnSync("pnpm", args, { encoding: "utf8" });
try {
  await writeFile(target, "export const unsafe: any = 1;\n", { flag: "wx" });
  const lint = run(["exec", "eslint", target, "--max-warnings=0"]);
  assert.notEqual(lint.status, 0);
  assert.ok((lint.stdout + lint.stderr).includes("no-explicit-any"));
  await writeFile(target, 'export const wrong: number = "not a number";\n');
  const types = run(["typecheck"]);
  assert.notEqual(types.status, 0);
  assert.ok((types.stdout + types.stderr).includes("TS2322"));
  await writeFile(
    target,
    Array.from(
      // Enough untested branches to pull a tree far above the threshold below it: the margin is a few percent.
      { length: 400 },
      (_, index) =>
        `export function untested${index}(value: number): number { return value > 1 ? value + 1 : value - 1; }`,
    ).join("\n") + "\n",
  );
  const coverage = run(["test", "--coverage"]);
  assert.notEqual(coverage.status, 0);
  // A run that fails for another reason has no threshold message; the tail of its
  // output is the evidence, so it goes into the assertion.
  const output = coverage.stdout + coverage.stderr;
  assert.ok(
    output.includes("does not meet global threshold"),
    `The coverage probe failed without the threshold message. End of its output:\n${output.slice(-4000)}`,
  );
  console.log("Lint, type and 90% coverage gates rejected the deliberate invalid inputs.");
} finally {
  await rm(target, { force: true });
}
