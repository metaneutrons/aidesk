import { unzipSync } from "fflate";
import { limits, type Extraction, type Failure, type Unit } from "./types";
// The text of Word, Excel and PowerPoint files (Office Open XML: a ZIP of XML
// parts). This is not an XML parser. It reads the runs of text of the few parts
// that hold them, and it refuses a part that declares entities or a document type
// (an Office file never does), so no entity can expand. A part that does not look
// like what it should is not interpreted.
class Refused extends Error {
  constructor(readonly reason: Failure) {
    super(reason);
  }
}
const decoder = new TextDecoder("utf-8");
type Parts = Record<string, Uint8Array>;
// The parts a caller names, inflated, and the names of all parts. Limits are
// checked on the declared sizes before anything is inflated; a package that lies
// about its sizes is stopped by the memory limit of the process that reads it.
function unpack(input: Uint8Array, wanted: (name: string) => boolean): Parts {
  let entries = 0;
  let declared = 0;
  try {
    return unzipSync(input, {
      filter: (file) => {
        entries += 1;
        declared += file.originalSize;
        if (entries > limits.entries || declared > limits.unpackedBytes)
          throw new Refused("too_large");
        if (!wanted(file.name)) return false;
        if (file.originalSize > limits.partBytes) throw new Refused("too_large");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused("damaged");
  }
}
function names(input: Uint8Array): Set<string> {
  const found = new Set<string>();
  unpack(input, (name) => {
    found.add(name);
    return false;
  });
  return found;
}
function xml(parts: Parts, name: string): string | null {
  const bytes = parts[name];
  if (!bytes) return null;
  const text = decoder.decode(bytes);
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) throw new Refused("damaged");
  return text;
}
const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
// The five predefined entities and numeric references; nothing else is expanded.
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, entity: string) => {
    if (!entity.startsWith("#")) return named[entity] ?? whole;
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : "";
  });
}
interface Tag {
  name: string;
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
}
type Piece = { tag: Tag } | { text: string };
function* pieces(source: string): Generator<Piece> {
  let position = 0;
  while (position < source.length) {
    const open = source.indexOf("<", position);
    if (open < 0) {
      yield { text: source.slice(position) };
      return;
    }
    if (open > position) yield { text: source.slice(position, open) };
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) return;
      position = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      const stop = end < 0 ? source.length : end;
      // Raw text: character data is not decoded, so it is escaped for the decoder.
      yield { text: source.slice(open + 9, stop).replace(/&/g, "&amp;") };
      position = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end < 0) return;
      position = end + 2;
      continue;
    }
    let index = open + 1;
    let quote = "";
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (index >= source.length) return;
    const inner = source.slice(open + 1, index);
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const body = inner.replace(/^\//, "").replace(/\/$/, "");
    const space = body.search(/\s/);
    yield {
      tag: {
        name: space < 0 ? body : body.slice(0, space),
        attrs: space < 0 ? "" : body.slice(space),
        closing,
        selfClosing,
      },
    };
    position = index + 1;
  }
}
const attributeCache = new Map<string, RegExp>();
function attr(attrs: string, name: string): string | undefined {
  let pattern = attributeCache.get(name);
  if (!pattern) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
    pattern = new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attributeCache.set(name, pattern);
  }
  const found = pattern.exec(attrs);
  const value = found?.[1] ?? found?.[2];
  return value === undefined ? undefined : decode(value);
}
const off = (value: string | undefined) => value === "0" || value === "false" || value === "off";
// The text that is kept, up to the limit.
class Text {
  private parts: string[] = [];
  private bytes = 0;
  truncated = false;
  push(value: string): void {
    if (this.truncated || value === "") return;
    const size = Buffer.byteLength(value);
    if (this.bytes + size > limits.textBytes) {
      this.parts.push(value.slice(0, Math.max(0, limits.textBytes - this.bytes)));
      this.truncated = true;
      return;
    }
    this.parts.push(value);
    this.bytes += size;
  }
  get full(): boolean {
    return this.truncated;
  }
  toString(): string {
    return this.parts.join("");
  }
}
const local = (name: string) => name.slice(name.indexOf(":") + 1);
// Word: the runs of the body. A run that is hidden by its formatting, set in white
// or set in a size nobody reads is left out and counted.
function docx(source: string, out: Text): number {
  let hidden = 0;
  let inText = false;
  let run: string | null = null;
  let concealed = false;
  for (const piece of pieces(source)) {
    if (out.full) break;
    if ("text" in piece) {
      if (inText && run !== null) run += decode(piece.text);
      continue;
    }
    const { tag } = piece;
    const name = local(tag.name);
    if (name === "p" && tag.closing) out.push("\n");
    else if (name === "r" && !tag.closing && !tag.selfClosing) {
      run = "";
      concealed = false;
    } else if (name === "r" && tag.closing) {
      if (run !== null) {
        if (concealed) {
          if (run.trim() !== "") hidden += 1;
        } else out.push(run);
      }
      run = null;
      inText = false;
    } else if (run !== null && !tag.closing) {
      if (name === "vanish" && !off(attr(tag.attrs, "w:val"))) concealed = true;
      else if (name === "color" && /^ffffff$/i.test(attr(tag.attrs, "w:val") ?? ""))
        concealed = true;
      else if (name === "sz" && Number(attr(tag.attrs, "w:val") ?? 99) <= 4) concealed = true;
      else if (name === "t" && !tag.selfClosing) inText = true;
      else if (name === "tab") run += "\t";
      else if (name === "br" || name === "cr") run += "\n";
      else if (name === "noBreakHyphen") run += "-";
    } else if (name === "t" && tag.closing) inText = false;
  }
  return hidden;
}
const column = (reference: string): number => {
  let index = 0;
  for (const char of reference) {
    const code = char.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index;
};
function sharedStrings(source: string | null): string[] {
  if (source === null) return [];
  const strings: string[] = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  for (const piece of pieces(source)) {
    if ("text" in piece) {
      if (current !== null && inText && phonetic === 0) current += decode(piece.text);
      continue;
    }
    const name = local(piece.tag.name);
    if (name === "si") {
      // An empty string keeps its place: cells name strings by their number.
      if (piece.tag.closing || piece.tag.selfClosing) {
        strings.push(current ?? "");
        current = null;
      } else current = "";
    } else if (name === "rPh") phonetic += piece.tag.closing ? -1 : piece.tag.selfClosing ? 0 : 1;
    else if (name === "t") inText = !piece.tag.closing && !piece.tag.selfClosing;
    if (strings.length > limits.cells) break;
  }
  return strings;
}
// Relationships of a part: id to target, relative to the folder of the part.
function relations(source: string | null, folder: string): Map<string, string> {
  const map = new Map<string, string>();
  if (source === null) return map;
  for (const piece of pieces(source)) {
    if (!("tag" in piece) || local(piece.tag.name) !== "Relationship") continue;
    const id = attr(piece.tag.attrs, "Id");
    const target = attr(piece.tag.attrs, "Target");
    if (id !== undefined && target !== undefined)
      map.set(id, target.startsWith("/") ? target.slice(1) : `${folder}${target}`);
  }
  return map;
}
const truthy = (value: string | undefined) => value !== undefined && !off(value);
// The cells of one sheet, row by row. Hidden rows and columns are left out and
// counted, and a sheet is cut at the limit of cells.
function sheet(source: string, strings: string[], out: Text, budget: { cells: number }): number {
  let hidden = 0;
  const hiddenColumns: [number, number][] = [];
  const cell = { ref: "", type: "", value: "", inline: "", inValue: false, inInline: false };
  const line = { cells: [] as string[], hidden: false };
  const flushRow = () => {
    if (line.cells.some((entry) => entry !== "")) {
      let last = line.cells.length;
      while (last > 0 && line.cells[last - 1] === "") last -= 1;
      out.push(`${line.cells.slice(0, last).join("\t")}\n`);
    }
    line.cells = [];
  };
  const closeCell = () => {
    let shown = cell.type === "inlineStr" ? cell.inline : cell.value;
    if (cell.type === "s") shown = strings[Number.parseInt(shown, 10)] ?? "";
    else if (cell.type === "b") shown = shown === "1" ? "TRUE" : shown === "0" ? "FALSE" : shown;
    const index = Math.max(column(cell.ref), line.cells.length + 1);
    const concealed =
      line.hidden || hiddenColumns.some(([from, to]) => index >= from && index <= to);
    if (shown !== "") budget.cells -= 1;
    while (line.cells.length < index - 1) line.cells.push("");
    if (concealed) {
      if (shown !== "") hidden += 1;
      line.cells.push("");
    } else line.cells.push(shown.replace(/[\t\r\n]+/g, " "));
    cell.value = "";
    cell.inline = "";
    cell.type = "";
  };
  for (const piece of pieces(source)) {
    if (out.full || budget.cells <= 0) break;
    if ("text" in piece) {
      if (cell.inValue) cell.value += decode(piece.text);
      else if (cell.inInline) cell.inline += decode(piece.text);
      continue;
    }
    const { tag } = piece;
    const name = local(tag.name);
    if (name === "col" && !tag.closing) {
      if (truthy(attr(tag.attrs, "hidden")))
        hiddenColumns.push([
          Number(attr(tag.attrs, "min") ?? 0),
          Number(attr(tag.attrs, "max") ?? 0),
        ]);
    } else if (name === "row") {
      if (tag.closing) flushRow();
      else {
        flushRow();
        line.hidden = truthy(attr(tag.attrs, "hidden"));
        if (tag.selfClosing) flushRow();
      }
    } else if (name === "c") {
      if (tag.closing) closeCell();
      else {
        cell.ref = attr(tag.attrs, "r") ?? "";
        cell.type = attr(tag.attrs, "t") ?? "";
        cell.value = "";
        cell.inline = "";
        if (tag.selfClosing) closeCell();
      }
    } else if (name === "v") cell.inValue = !tag.closing && !tag.selfClosing;
    else if (name === "is") cell.inInline = !tag.closing && !tag.selfClosing;
  }
  flushRow();
  return hidden;
}
// Excel: the visible sheets, one line per row, cells apart by a tab. Hidden
// sheets are left out and counted.
function xlsx(parts: Parts, out: Text): { sheets: number; hidden: number } {
  const book = xml(parts, "xl/workbook.xml") ?? "";
  const rels = relations(xml(parts, "xl/_rels/workbook.xml.rels"), "xl/");
  const strings = sharedStrings(xml(parts, "xl/sharedStrings.xml"));
  const budget: { cells: number } = { cells: limits.cells };
  let hidden = 0;
  let sheets = 0;
  for (const piece of pieces(book)) {
    if (!("tag" in piece) || local(piece.tag.name) !== "sheet" || piece.tag.closing) continue;
    const state = attr(piece.tag.attrs, "state");
    if (state === "hidden" || state === "veryHidden") {
      hidden += 1;
      continue;
    }
    const target = rels.get(attr(piece.tag.attrs, "r:id") ?? "");
    const source = target === undefined ? null : xml(parts, target);
    if (source === null || out.full) continue;
    sheets += 1;
    out.push(`# ${attr(piece.tag.attrs, "name") ?? `Sheet ${String(sheets)}`}\n`);
    hidden += sheet(source, strings, out, budget);
  }
  if (budget.cells <= 0) out.truncated = true;
  return { sheets, hidden };
}
// PowerPoint: the text of the slides in the order of the presentation. A hidden
// slide is left out and counted. Speaker notes are not read.
function pptx(parts: Parts, out: Text): { slides: number; hidden: number } {
  const presentation = xml(parts, "ppt/presentation.xml") ?? "";
  const rels = relations(xml(parts, "ppt/_rels/presentation.xml.rels"), "ppt/");
  const order: string[] = [];
  for (const piece of pieces(presentation)) {
    if (!("tag" in piece) || local(piece.tag.name) !== "sldId" || piece.tag.closing) continue;
    const target = rels.get(attr(piece.tag.attrs, "r:id") ?? "");
    if (target !== undefined) order.push(target);
  }
  let hidden = 0;
  let slides = 0;
  for (const target of order) {
    if (out.full) break;
    const source = xml(parts, target);
    if (source === null) continue;
    let concealed = false;
    let inText = false;
    let slide = "";
    for (const piece of pieces(source)) {
      if ("text" in piece) {
        if (inText) slide += decode(piece.text);
        continue;
      }
      const name = local(piece.tag.name);
      if (name === "sld" && !piece.tag.closing && off(attr(piece.tag.attrs, "show")))
        concealed = true;
      else if (name === "t") inText = !piece.tag.closing && !piece.tag.selfClosing;
      else if (name === "p" && piece.tag.closing) slide += "\n";
      else if (name === "br") slide += "\n";
    }
    if (concealed) {
      hidden += 1;
      continue;
    }
    slides += 1;
    out.push(`## Slide ${String(slides)}\n${slide}\n`);
  }
  return { slides, hidden };
}
export function extractOoxml(input: Uint8Array): Extraction {
  try {
    const found = names(input);
    const out = new Text();
    let unit: Unit;
    let units: number;
    let hidden: number;
    let method: string;
    if (found.has("word/document.xml")) {
      const parts = unpack(input, (name) => name === "word/document.xml");
      hidden = docx(xml(parts, "word/document.xml") ?? "", out);
      units = 1;
      unit = "pages";
      method = "ooxml-docx";
    } else if (found.has("xl/workbook.xml")) {
      const parts = unpack(
        input,
        (name) =>
          name === "xl/workbook.xml" ||
          name === "xl/_rels/workbook.xml.rels" ||
          name === "xl/sharedStrings.xml" ||
          (name.startsWith("xl/worksheets/") && name.endsWith(".xml")),
      );
      const read = xlsx(parts, out);
      units = read.sheets;
      hidden = read.hidden;
      unit = "sheets";
      method = "ooxml-xlsx";
    } else if (found.has("ppt/presentation.xml")) {
      const parts = unpack(
        input,
        (name) =>
          name === "ppt/presentation.xml" ||
          name === "ppt/_rels/presentation.xml.rels" ||
          (name.startsWith("ppt/slides/") && name.endsWith(".xml")),
      );
      const read = pptx(parts, out);
      units = read.slides;
      hidden = read.hidden;
      unit = "slides";
      method = "ooxml-pptx";
    } else return { ok: false, reason: "unsupported" };
    const text = out
      .toString()
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text === "") return { ok: false, reason: "empty" };
    return { ok: true, method, text, units, unit, truncated: out.truncated, hidden };
  } catch (error) {
    return { ok: false, reason: error instanceof Refused ? error.reason : "failed" };
  }
}
