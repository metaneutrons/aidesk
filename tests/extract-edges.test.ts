import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractOoxml } from "../src/server/extract/ooxml";
import { extractPdf } from "../src/server/extract/pdf";
import { reader, residentMb, runIsolated } from "../src/server/extract/sandbox";
import { limits } from "../src/server/extract/types";
import { pdf, zip } from "./support/documents";
const head = '<?xml version="1.0"?>';
const wordPart = (body: string) =>
  zip({ "word/document.xml": `${head}<w:document>${body}</w:document>` });
const read = (bytes: Uint8Array) => {
  const answer = extractOoxml(bytes);
  if (!answer.ok) throw new Error(`not read: ${answer.reason}`);
  return answer;
};
describe("the reader of Word text", () => {
  it("skips comments and instructions, keeps character data as it is and takes tabs, breaks and hyphens", () => {
    const answer = read(
      wordPart(
        [
          "<!-- <w:t>not text</w:t> --><?instruction x?>",
          "<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:noBreakHyphen/><w:cr/><w:t>d</w:t></w:r></w:p>",
          "<w:p><w:r><w:t><![CDATA[x <y> &amp; z]]></w:t></w:r></w:p>",
          '<w:p><w:r><w:rPr><w:b title="a>b"/></w:rPr><w:t>q&#xD800;r&#0;s&#x41;&#66;</w:t></w:r></w:p>',
          "<w:p><w:r><w:t/></w:r><w:r/></w:p>",
        ].join(""),
      ),
    );
    expect(answer.text).toBe("a\tb\nc-\nd\nx <y> &amp; z\nqrsAB");
  });
  it("stops at a tag or a comment that never ends and keeps what came before", () => {
    expect(read(wordPart("<w:p><w:r><w:t>kept</w:t></w:r></w:p><w:p")).text).toBe("kept");
    expect(read(wordPart("<w:p><w:r><w:t>kept</w:t></w:r></w:p><!-- never ends")).text).toBe(
      "kept",
    );
    expect(read(wordPart("<w:p><w:r><w:t>kept</w:t></w:r></w:p><?pi never ends")).text).toBe(
      "kept",
    );
    expect(read(wordPart("<w:p><w:r><w:t>kept</w:t></w:r></w:p><![CDATA[open")).text).toBe("kept");
  });
});
const book = (sheets: string, rels: string) =>
  ({
    "xl/workbook.xml": `${head}<workbook xmlns:r="r"><sheets>${sheets}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${head}<Relationships>${rels}</Relationships>`,
  }) as Record<string, string>;
describe("the reader of Excel text", () => {
  it("reads inline, rich and formula strings, booleans, empty cells and rows, and names a sheet that has no name", () => {
    const files = {
      ...book(
        '<sheet r:id="rId1"/><sheet name="Gone" r:id="rId9"/><sheet name="Absolute" r:id="rId2"/>',
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Target="x"/>',
      ),
      "xl/sharedStrings.xml": `${head}<sst><si><r><t>rich </t></r><r><t>text</t></r><rPh><t>phonetic</t></rPh></si><si/><si><t>two</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `${head}<worksheet><cols><col min="1" max="1" hidden="0"/><col min="9" max="9"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inline</t></is></c><c r="B1" t="b"><v>0</v></c><c r="C1"/><c r="D1" t="str"><v>formula text</v></c><c r="E1" t="b"><v>maybe</v></c><c r="F1" t="s"><v>0</v></c><c r="G1" t="s"><v>99</v></c><c r="H1"><f>1+1</f><v>2</v></c></row><row r="2"/><row r="3"><c r="A3" t="s"><v>2</v></c></row></sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `${head}<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
    };
    const answer = read(zip(files));
    expect(answer.units).toBe(2);
    expect(answer.text).toBe(
      "# Sheet 1\ninline\tFALSE\t\tformula text\tmaybe\trich text\t\t2\ntwo\n# Absolute\n7",
    );
  });
  it("stops at the limit of cells and says so", () => {
    const cells = Array.from(
      { length: limits.cells + 10 },
      (_, index) => `<c r="A1"><v>${String(index)}</v></c>`,
    ).join("");
    const answer = read(
      zip({
        ...book(
          '<sheet name="Big" r:id="rId1"/>',
          '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>',
        ),
        "xl/worksheets/sheet1.xml": `${head}<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
      }),
    );
    expect(answer.truncated).toBe(true);
  });
});
describe("the reader of PowerPoint text", () => {
  it("takes line breaks, skips a slide whose file is missing and ends when the text is full", () => {
    const rels =
      '<Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/>';
    const presentation =
      '<p:sldIdLst><p:sldId r:id="rId1"/><p:sldId r:id="rId2"/><p:sldId r:id="rId7"/></p:sldIdLst>';
    const answer = read(
      zip({
        "ppt/presentation.xml": `${head}<p:presentation xmlns:r="r">${presentation}</p:presentation>`,
        "ppt/_rels/presentation.xml.rels": `${head}<Relationships>${rels}</Relationships>`,
        "ppt/slides/slide1.xml": `${head}<p:sld><a:p><a:r><a:t>one</a:t></a:r><a:br/><a:r><a:t>two</a:t></a:r></a:p></p:sld>`,
      }),
    );
    expect(answer).toMatchObject({ units: 1, text: "## Slide 1\none\ntwo" });
    const long = "y".repeat(2000);
    const full = read(
      zip({
        "ppt/presentation.xml": `${head}<p:presentation xmlns:r="r">${presentation}</p:presentation>`,
        "ppt/_rels/presentation.xml.rels": `${head}<Relationships>${rels}</Relationships>`,
        "ppt/slides/slide1.xml": `${head}<p:sld>${Array.from({ length: 700 }, () => `<a:p><a:r><a:t>${long}</a:t></a:r></a:p>`).join("")}</p:sld>`,
        "ppt/slides/slide2.xml": `${head}<p:sld><a:p><a:r><a:t>after</a:t></a:r></a:p></p:sld>`,
      }),
    );
    expect(full.truncated).toBe(true);
    expect(full.text).not.toContain("after");
  });
});
describe("the reader of PDF text", () => {
  it("cuts the text at the limit and says so", async () => {
    // Text of more than the limit: two pages of 14 400 points with 200 lines of 3000 characters.
    const line = "z".repeat(3000);
    const page = Array.from({ length: 200 }, (_, index) => ({
      text: line,
      y: 14_000 - index * 9,
      size: 8,
    }));
    const answer = await extractPdf(pdf([page, page], { page: [14_400, 14_400] }));
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.truncated).toBe(true);
      expect(Buffer.byteLength(answer.text)).toBeLessThanOrEqual(limits.textBytes);
    }
  });
  it("reports a header with nothing behind it as not readable", async () => {
    const answer = await extractPdf(Buffer.from("%PDF-1.7\n%%EOF"));
    expect(answer.ok).toBe(false);
  });
});
describe("running the closed process", () => {
  const program = (name: string) => path.join(process.cwd(), "tests/support", name);
  it("builds its program once for a version of the sources and builds it again when it is gone", async () => {
    // Its own folder, so that the other tests keep the program they use.
    const base = mkdtempSync(path.join(tmpdir(), "aidesk-reader-test-"));
    try {
      const first = await reader(base);
      expect(first.startsWith(base)).toBe(true);
      expect(existsSync(first)).toBe(true);
      const built = statSync(first).mtimeMs;
      expect(await reader(base)).toBe(first);
      expect(statSync(first).mtimeMs).toBe(built);
      rmSync(path.dirname(first), { recursive: true, force: true });
      expect(await reader(base)).toBe(first);
      expect(existsSync(first)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
  it("tells a program that ends with an error, one that answers no JSON, one that aborts, and one that cannot start", async () => {
    expect(await runIsolated(program("probe-exit.mjs"), new Uint8Array(0))).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await runIsolated(program("probe-notjson.mjs"), new Uint8Array(0))).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(
      await runIsolated(program("probe-heap.mjs"), new Uint8Array(0), { memoryMb: 24 }),
    ).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(
      await runIsolated(program("probe-exit.mjs"), new Uint8Array(0), {
        executable: "/nonexistent/node",
      }),
    ).toEqual({ ok: false, reason: "failed" });
  }, 60_000);
  it("reads the memory of a process, through ps where /proc is not there, and says nothing for one that is gone", () => {
    expect(residentMb(process.pid)).toBeGreaterThan(10);
    // Without /proc the answer comes from ps when the machine has it, else nothing.
    const fallback = residentMb(process.pid, "/nonexistent-proc");
    expect(fallback === null || fallback > 10).toBe(true);
    expect(residentMb(2_147_483_000, "/nonexistent-proc")).toBeNull();
  });
});
