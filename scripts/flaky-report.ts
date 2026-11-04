import { readFileSync, appendFileSync } from "node:fs";
// Lists the tests that failed and then passed on a repeat, from the JSON report of Playwright. With one repeat in CI
// such a test no longer fails the job, so the list is how it stays visible: as a warning on the run and as a table in
// the summary of the job.
interface Test {
  projectName?: string;
  status?: string;
}
interface Spec {
  title: string;
  file: string;
  line: number;
  tests?: Test[];
}
interface Suite {
  specs?: Spec[];
  suites?: Suite[];
}
export interface Flaky {
  title: string;
  file: string;
  line: number;
  project: string;
}
export function flakyTests(report: { suites?: Suite[] }): Flaky[] {
  const found: Flaky[] = [];
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        if (test.status === "flaky")
          found.push({
            title: spec.title,
            file: spec.file,
            line: spec.line,
            project: test.projectName ?? "",
          });
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return found;
}
export function summary(found: Flaky[]): string {
  if (found.length === 0) return "No test needed a repeat.\n";
  const rows = found.map(
    (test) => `| ${test.project} | \`${test.file}:${String(test.line)}\` | ${test.title} |`,
  );
  return [
    `${String(found.length)} test(s) failed and passed on the repeat:`,
    "",
    "| Browser | Spec | Test |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
if (process.argv[1]?.endsWith("flaky-report.ts")) {
  const path = process.argv[2] ?? "test-results/results.json";
  const found = flakyTests(JSON.parse(readFileSync(path, "utf8")) as { suites?: Suite[] });
  for (const test of found)
    console.log(
      `::warning file=tests/e2e/${test.file},line=${String(test.line)}::passed only on the repeat in ${test.project}: ${test.title}`,
    );
  const text = summary(found);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
