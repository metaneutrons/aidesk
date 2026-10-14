import * as worker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { limits, type Extraction } from "./types";
// The text layer of a PDF file, page by page. pdf.js runs in the same process
// with its worker module handed over directly (a worker thread would need more
// rights), without scripts and without XFA forms; version 6 no longer evaluates
// font programs at all. A file
// that needs a password or has no text layer is reported as such; pages that
// are only images are not read here.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
// Text of a size nobody reads is not shown to a reader and is left out and counted.
// Text that lies outside the page is not returned by pdf.js at all.
const smallest = 2;
export async function extractPdf(input: Uint8Array): Promise<Extraction> {
  try {
    const document = await getDocument({
      // pdf.js wants a plain Uint8Array and takes it over, so it gets a copy.
      data: Uint8Array.from(input),
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: false,
      verbosity: 0,
    }).promise;
    const read = Math.min(document.numPages, limits.pages);
    let text = "";
    let hidden = 0;
    // Pages beyond the limit are not read, and so is the rest once the text is full.
    let truncated = document.numPages > read;
    let full = false;
    for (let number = 1; number <= read && !full; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const [a = 0, b = 0] = item.transform as number[];
        if (item.str.trim() !== "" && Math.hypot(a, b) < smallest) {
          hidden += 1;
          continue;
        }
        line += item.hasEOL ? `${item.str}\n` : `${item.str} `;
      }
      text += `${line}\n\n`;
      if (Buffer.byteLength(text) > limits.textBytes) {
        text = text.slice(0, limits.textBytes);
        truncated = true;
        full = true;
      }
    }
    const clean = text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (clean === "") return { ok: false, reason: "empty" };
    return {
      ok: true,
      method: "pdfjs",
      text: clean,
      units: read,
      unit: "pages",
      truncated,
      hidden,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") return { ok: false, reason: "encrypted" };
    if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException")
      return { ok: false, reason: "damaged" };
    return { ok: false, reason: "failed" };
  }
}
