import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
// Documents for the tests of the file readers, built here so that every test
// states what is in the file it reads. They are small, valid enough for the
// readers, and not meant to open in a word processor.
type Files = Record<string, string | Uint8Array>;
export function zip(files: Files): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        typeof content === "string" ? strToU8(content) : content,
      ]),
    ),
    { level: 0 },
  );
}
const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// Word. A run is text, or an object that sets formatting around it.
export interface Run {
  text: string;
  properties?: string;
  // The text is XML as it is, with its entities.
  raw?: boolean;
}
export function docx(
  paragraphs: (string | Run[])[],
  extra: Files = {},
  head = xmlHead,
): Uint8Array {
  const body = paragraphs
    .map((paragraph) => {
      const runs = typeof paragraph === "string" ? [{ text: paragraph }] : paragraph;
      return `<w:p>${runs
        .map(
          (run) =>
            `<w:r>${run.properties ? `<w:rPr>${run.properties}</w:rPr>` : ""}<w:t xml:space="preserve">${run.raw ? run.text : escape(run.text)}</w:t></w:r>`,
        )
        .join("")}</w:p>`;
    })
    .join("");
  return zip({
    "[Content_Types].xml": `${xmlHead}<Types/>`,
    "word/document.xml": `${head}<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
    ...extra,
  });
}
// Excel. A sheet is rows of cells; a cell is text, a number, a boolean or
// null for an empty one. `hidden` rows and columns and sheets are marked.
export interface Sheet {
  name: string;
  rows: (string | number | boolean | null)[][];
  state?: string;
  hiddenRows?: number[];
  hiddenColumns?: number[];
}
const letters = (index: number) => String.fromCharCode(65 + index);
export function xlsx(sheets: Sheet[]): Uint8Array {
  const strings: string[] = [];
  const files: Files = {
    "[Content_Types].xml": `${xmlHead}<Types/>`,
    "xl/workbook.xml": `${xmlHead}<workbook xmlns:r="r"><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escape(sheet.name)}" sheetId="${String(index + 1)}"${sheet.state ? ` state="${sheet.state}"` : ""} r:id="rId${String(index + 1)}"/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${xmlHead}<Relationships>${sheets
      .map(
        (_, index) =>
          `<Relationship Id="rId${String(index + 1)}" Type="t" Target="worksheets/sheet${String(index + 1)}.xml"/>`,
      )
      .join("")}</Relationships>`,
  };
  sheets.forEach((sheet, index) => {
    const columns = (sheet.hiddenColumns ?? [])
      .map((column) => `<col min="${String(column)}" max="${String(column)}" hidden="1"/>`)
      .join("");
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, columnIndex) => {
            const ref = `${letters(columnIndex)}${String(rowIndex + 1)}`;
            if (value === null) return "";
            if (typeof value === "number") return `<c r="${ref}"><v>${String(value)}</v></c>`;
            if (typeof value === "boolean")
              return `<c r="${ref}" t="b"><v>${value ? "1" : "0"}</v></c>`;
            strings.push(value);
            return `<c r="${ref}" t="s"><v>${String(strings.length - 1)}</v></c>`;
          })
          .join("");
        const hidden = (sheet.hiddenRows ?? []).includes(rowIndex + 1) ? ' hidden="1"' : "";
        return `<row r="${String(rowIndex + 1)}"${hidden}>${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/sheet${String(index + 1)}.xml`] =
      `${xmlHead}<worksheet>${columns ? `<cols>${columns}</cols>` : ""}<sheetData>${rows}</sheetData></worksheet>`;
  });
  files["xl/sharedStrings.xml"] =
    `${xmlHead}<sst>${strings.map((value) => `<si><t xml:space="preserve">${escape(value)}</t></si>`).join("")}</sst>`;
  return zip(files);
}
// PowerPoint. Slides are listed in the order of the presentation, which need not
// be the order of their file names.
export interface Slide {
  file: number;
  paragraphs: string[];
  hidden?: boolean;
}
export function pptx(slides: Slide[], notes: Record<number, string> = {}): Uint8Array {
  const files: Files = {
    "[Content_Types].xml": `${xmlHead}<Types/>`,
    "ppt/presentation.xml": `${xmlHead}<p:presentation xmlns:r="r"><p:sldIdLst>${slides
      .map(
        (slide, index) => `<p:sldId id="${String(256 + index)}" r:id="rId${String(slide.file)}"/>`,
      )
      .join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `${xmlHead}<Relationships>${slides
      .map(
        (slide) =>
          `<Relationship Id="rId${String(slide.file)}" Type="t" Target="slides/slide${String(slide.file)}.xml"/>`,
      )
      .join("")}</Relationships>`,
  };
  for (const slide of slides)
    files[`ppt/slides/slide${String(slide.file)}.xml`] =
      `${xmlHead}<p:sld xmlns:a="a"${slide.hidden ? ' show="0"' : ""}>${slide.paragraphs
        .map((text) => `<a:p><a:r><a:t>${escape(text)}</a:t></a:r></a:p>`)
        .join("")}</p:sld>`;
  for (const [file, text] of Object.entries(notes))
    files[`ppt/notesSlides/notesSlide${file}.xml`] =
      `${xmlHead}<p:notes xmlns:a="a"><a:p><a:r><a:t>${escape(text)}</a:t></a:r></a:p></p:notes>`;
  return zip(files);
}
// A PDF written by hand: pages of text items, each at a position and size.
export interface Item {
  text: string;
  x?: number;
  y?: number;
  size?: number;
}
export interface PdfOptions {
  // The size of a page in points; text beyond it is clipped by the readers.
  page?: [number, number];
  // The standard security handler with this user password, so that a reader
  // without the password is refused.
  password?: string;
}
const padding = Uint8Array.from(
  "28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A"
    .match(/../g)
    ?.map((hex) => Number.parseInt(hex, 16)) ?? [],
);
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (state[i] ?? 0) + (key[i % key.length] ?? 0)) & 255;
    [state[i], state[j]] = [state[j] ?? 0, state[i] ?? 0];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  data.forEach((value, index) => {
    a = (a + 1) & 255;
    b = (b + (state[a] ?? 0)) & 255;
    [state[a], state[b]] = [state[b] ?? 0, state[a] ?? 0];
    out[index] = value ^ (state[((state[a] ?? 0) + (state[b] ?? 0)) & 255] ?? 0);
  });
  return out;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex").toUpperCase();
export function pdf(pages: Item[][], options: PdfOptions = {}): Uint8Array {
  const objects: string[] = [];
  const kids: string[] = [];
  objects.push("");
  objects.push("");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const page of pages) {
    const stream = page
      .map(
        (item) =>
          `BT /F1 ${String(item.size ?? 14)} Tf ${String(item.x ?? 20)} ${String(item.y ?? 100)} Td (${item.text.replace(/[()\\]/g, "\\$&")}) Tj ET`,
      )
      .join("\n");
    objects.push(`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`);
    const content = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(options.page?.[0] ?? 300)} ${String(options.page?.[1] ?? 144)}] /Contents ${String(content)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    kids.push(`${String(objects.length)} 0 R`);
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${String(pages.length)} >>`;
  let trailer = "";
  if (options.password !== undefined) {
    // Algorithms 2 and 4 of the PDF standard security handler, revision 2: the
    // user entry is made from the key of the password, so that no other
    // password opens the file.
    const owner = new Uint8Array(32).fill(7);
    const id = Buffer.from("0123456789abcdef");
    const permissions = Buffer.alloc(4);
    permissions.writeInt32LE(-4);
    const secret = Buffer.from(options.password, "latin1");
    const padded = Buffer.concat([secret, padding]).subarray(0, 32);
    const key = createHash("md5")
      .update(padded)
      .update(owner)
      .update(permissions)
      .update(id)
      .digest()
      .subarray(0, 5);
    const user = rc4(key, padding);
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${hex(owner)}> /U <${hex(user)}> /P -4 >>`);
    trailer = ` /Encrypt ${String(objects.length)} 0 R /ID [<${hex(id)}> <${hex(id)}>]`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R${trailer} >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
