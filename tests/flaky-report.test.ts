import { describe, expect, it } from "vitest";
import { flakyTests, summary } from "../scripts/flaky-report";
const report = {
  suites: [
    {
      specs: [],
      suites: [
        {
          specs: [
            {
              title: "passes at once",
              file: "a.spec.ts",
              line: 3,
              tests: [{ projectName: "chromium", status: "expected" }],
            },
            {
              title: "passes on the repeat",
              file: "a.spec.ts",
              line: 9,
              tests: [
                { projectName: "firefox", status: "flaky" },
                { projectName: "webkit", status: "expected" },
              ],
            },
            {
              title: "fails twice",
              file: "a.spec.ts",
              line: 15,
              tests: [{ projectName: "webkit", status: "unexpected" }],
            },
            {
              title: "is skipped",
              file: "a.spec.ts",
              line: 20,
              tests: [{ projectName: "webkit", status: "skipped" }],
            },
          ],
          suites: [
            {
              specs: [
                {
                  title: "nested flaky",
                  file: "b.spec.ts",
                  line: 4,
                  tests: [{ projectName: "chromium", status: "flaky" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
describe("the report of tests that needed a repeat", () => {
  it("lists only the tests that failed and then passed, in nested suites as well", () => {
    expect(flakyTests(report)).toEqual([
      { title: "passes on the repeat", file: "a.spec.ts", line: 9, project: "firefox" },
      { title: "nested flaky", file: "b.spec.ts", line: 4, project: "chromium" },
    ]);
  });
  it("says so when nothing needed a repeat, and tolerates an empty report", () => {
    expect(flakyTests({})).toEqual([]);
    expect(summary([])).toBe("No test needed a repeat.\n");
  });
  it("writes a table with the browser, the place and the title", () => {
    const text = summary(flakyTests(report));
    expect(text).toContain("2 test(s) failed and passed on the repeat:");
    expect(text).toContain("| firefox | `a.spec.ts:9` | passes on the repeat |");
  });
});
