import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractBytes } from "../src/server/extract/core";
import { extractOoxml } from "../src/server/extract/ooxml";
import { extractPdf } from "../src/server/extract/pdf";
import { limits } from "../src/server/extract/types";
import { docx, pdf, pptx, xlsx, zip } from "./support/documents";
const read = (bytes: Uint8Array) => extractBytes(bytes);
const text = async (bytes: Uint8Array) => {
  const answer = await read(bytes);
  if (!answer.ok) throw new Error(`not read: ${answer.reason}`);
  return answer;
};
describe("Word files", () => {
  it("gives the paragraphs, tabs and line breaks, and decodes the five entities and numbers", async () => {
    const answer = await text(
      docx([
        [
          {
            text: "First paragraph, &amp; &lt;tags&gt; &quot;quoted&quot; &apos;x&apos;",
            raw: true,
          },
        ],
        [{ text: "Umlaut &#228; and &#x20AC; and &unknown; stays", raw: true }],
      ]),
    );
    expect(answer).toMatchObject({
      method: "ooxml-docx",
      unit: "pages",
      truncated: false,
      hidden: 0,
    });
    expect(answer.text).toBe(
      "First paragraph, & <tags> \"quoted\" 'x'\n" + "Umlaut ä and € and &unknown; stays",
    );
  });
  it("leaves out text that is deleted, a field code and text that is hidden, and counts the hidden", async () => {
    const answer = await text(
      docx([
        "Visible",
        [
          { text: "vanished", properties: "<w:vanish/>" },
          { text: " white", properties: '<w:color w:val="FFFFFF"/>' },
          { text: " tiny", properties: '<w:sz w:val="2"/>' },
          { text: " shown", properties: '<w:vanish w:val="0"/>' },
          { text: " grey", properties: '<w:color w:val="808080"/><w:sz w:val="22"/>' },
        ],
      ]),
    );
    expect(answer.text).toBe("Visible\n shown grey");
    expect(answer.hidden).toBe(3);
  });
  it("cuts the text at the limit and says so", async () => {
    const line = "x".repeat(1000);
    const answer = await text(docx(Array.from({ length: 1200 }, () => line)));
    expect(answer.truncated).toBe(true);
    expect(Buffer.byteLength(answer.text)).toBeLessThanOrEqual(limits.textBytes);
  });
  it("refuses a part that declares a document type or entities, so none can expand", () => {
    const bomb = '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>';
    expect(extractOoxml(docx(["x &b;"], {}, `<?xml version="1.0"?>${bomb}`))).toEqual({
      ok: false,
      reason: "damaged",
    });
    expect(extractOoxml(docx(["x"], {}, '<?xml version="1.0"?><!ENTITY a "b">'))).toEqual({
      ok: false,
      reason: "damaged",
    });
  });
  it("reports a file without text, and one without the part of a Word file", async () => {
    expect(await read(docx([""]))).toEqual({ ok: false, reason: "empty" });
    expect(await read(zip({ "readme.txt": "just a zip" }))).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});
describe("Excel files", () => {
  it("gives the sheets with a line per row, cells apart by a tab and gaps kept", async () => {
    const answer = await text(
      xlsx([
        {
          name: "Orders",
          rows: [
            ["Item", "Count", "Paid"],
            ["Pen", 3, true],
            ["Cap", null, "x\ty"],
          ],
        },
        { name: "Notes", rows: [["Second sheet"]] },
      ]),
    );
    expect(answer).toMatchObject({ method: "ooxml-xlsx", unit: "sheets", units: 2, hidden: 0 });
    expect(answer.text).toBe(
      "# Orders\nItem\tCount\tPaid\nPen\t3\tTRUE\nCap\t\tx y\n# Notes\nSecond sheet",
    );
  });
  it("leaves out hidden sheets, rows and columns and counts them", async () => {
    const answer = await text(
      xlsx([
        {
          name: "Open",
          rows: [
            ["a", "secret column", "c"],
            ["hidden row", "x", "y"],
            ["d", "e", "f"],
          ],
          hiddenColumns: [2],
          hiddenRows: [2],
        },
        { name: "Secret", rows: [["do not show"]], state: "hidden" },
        { name: "Deep", rows: [["nor this"]], state: "veryHidden" },
      ]),
    );
    expect(answer.units).toBe(1);
    expect(answer.text).toBe("# Open\na\t\tc\nd\t\tf");
    // Two sheets, the cell of the hidden column in each row (3 rows, the hidden row
    // counted with its three cells once) and nothing twice.
    expect(answer.hidden).toBe(2 + 1 + 3 + 1);
    expect(answer.text).not.toContain("secret");
    expect(answer.text).not.toContain("do not show");
  });
});
describe("PowerPoint files", () => {
  it("gives the slides in the order of the presentation, leaves out hidden ones and notes", async () => {
    const answer = await text(
      pptx(
        [
          { file: 2, paragraphs: ["Second file, first slide", "line two"] },
          { file: 1, paragraphs: ["First file, second slide"] },
          { file: 3, paragraphs: ["hidden slide"], hidden: true },
        ],
        { 1: "speaker notes are not read" },
      ),
    );
    expect(answer).toMatchObject({ method: "ooxml-pptx", unit: "slides", units: 2, hidden: 1 });
    expect(answer.text).toBe(
      "## Slide 1\nSecond file, first slide\nline two\n\n## Slide 2\nFirst file, second slide",
    );
  });
});
// A package whose headers declare another unpacked size than its parts have. The
// limits are judged on the declared sizes, so a small package can stand for a huge
// one without the test packing or unpacking anything large.
function declaring(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  const text = new TextDecoder("latin1").decode(copy);
  for (let index = 0; index + 46 <= copy.length; index += 1) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    const length = view.getUint16(index + 28, true);
    if (text.slice(index + 46, index + 46 + length) !== name) continue;
    view.setUint32(index + 24, size, true);
  }
  return copy;
}
describe("limits of a package", () => {
  it("refuses a package with too many parts and one that unpacks to too much", () => {
    const many: Record<string, Uint8Array> = {};
    for (let index = 0; index <= limits.entries; index += 1)
      many[`part${String(index)}.txt`] = strToU8("x");
    expect(extractOoxml(zipSync(many))).toEqual({ ok: false, reason: "too_large" });
    const small = zipSync({
      "word/document.xml": strToU8("<w:document/>"),
      "word/media/huge.bin": strToU8("x"),
    });
    expect(extractOoxml(declaring(small, "word/media/huge.bin", limits.unpackedBytes + 1))).toEqual(
      {
        ok: false,
        reason: "too_large",
      },
    );
    // One part of a Word file that is larger than a part may be.
    const single = zipSync({ "word/document.xml": strToU8("<w:document/>") });
    expect(extractOoxml(declaring(single, "word/document.xml", limits.partBytes + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
    // The same package, declared within the limits, is read.
    expect(extractOoxml(declaring(small, "word/media/huge.bin", 1))).toEqual({
      ok: false,
      reason: "empty",
    });
  }, 30_000);
  it("calls a file that is not a package damaged", async () => {
    const broken = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await read(broken)).toEqual({ ok: false, reason: "damaged" });
  });
});
describe("PDF files", () => {
  it("gives the text of the pages in order", async () => {
    const answer = await text(pdf([[{ text: "First page text" }], [{ text: "Second page text" }]]));
    expect(answer).toMatchObject({
      method: "pdfjs",
      unit: "pages",
      units: 2,
      truncated: false,
      hidden: 0,
    });
    expect(answer.text).toContain("First page text");
    expect(answer.text.indexOf("First")).toBeLessThan(answer.text.indexOf("Second"));
  });
  it("leaves out text that is too small to read and counts it; text off the page is never returned", async () => {
    const answer = await text(
      pdf([
        [
          { text: "Readable line" },
          { text: "tiny secret", size: 1 },
          { text: "off the page", x: 900, y: 100 },
          { text: "below the page", x: 20, y: -300 },
        ],
      ]),
    );
    expect(answer.text).toContain("Readable line");
    expect(answer.text).not.toContain("tiny");
    expect(answer.text).not.toContain("off the page");
    expect(answer.text).not.toContain("below");
    expect(answer.hidden).toBe(1);
  });
  it("reads only as many pages as the limit and says so", async () => {
    const pages = Array.from({ length: limits.pages + 5 }, (_, index) => [
      { text: `Page ${String(index + 1)}` },
    ]);
    const answer = await text(pdf(pages));
    expect(answer).toMatchObject({ units: limits.pages, truncated: true });
    expect(answer.text).toContain(`Page ${String(limits.pages)}`);
    expect(answer.text).not.toContain(`Page ${String(limits.pages + 1)}`);
  });
  it("reports a file with a password, a broken file and one without text", async () => {
    expect(await extractPdf(pdf([[{ text: "secret" }]], { password: "hunter2" }))).toEqual({
      ok: false,
      reason: "encrypted",
    });
    expect(await extractPdf(Buffer.from("%PDF-1.4\nthis is not a pdf at all"))).toEqual({
      ok: false,
      reason: "damaged",
    });
    expect(await extractPdf(pdf([[]]))).toEqual({ ok: false, reason: "empty" });
  });
  it("takes a file for what its content says, whatever it is called", async () => {
    expect(await read(Buffer.from("plain text, not a document"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    // The signature of an old binary Office file or a protected one.
    const old = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(await read(old)).toEqual({ ok: false, reason: "unsupported" });
    expect(await read(new Uint8Array(limits.inputBytes + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});
