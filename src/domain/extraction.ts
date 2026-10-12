// Parser-based extraction of the new part of an inbound mail, without AI.
// It only removes material at the end of the message that is clearly earlier
// correspondence or a signature. Text between quoted passages (inline
// replies) is never removed; quoted lines stay as Markdown block quotes.
export interface Extraction {
  markdown: string;
  // Whether anything was removed; the private original stays available.
  trimmed: boolean;
}
const attribution = [
  /^on\b.{0,200}\bwrote:\s*$/i,
  /^am\b.{0,200}\bschrieb\b.{0,200}:\s*$/i,
  /^le\b.{0,200}\ba écrit\s*:\s*$/i,
  /^-{2,}\s*(original message|ursprüngliche nachricht|originalnachricht)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
];
const headerStart = /^(from|von):\s/i;
const headerFollow = /^(sent|gesendet|date|datum|to|an|subject|betreff):\s/i;
function isQuote(line: string): boolean {
  return line.trimStart().startsWith(">");
}
function isBlank(line: string): boolean {
  return line.trim() === "";
}
// True when nothing but quoted or blank lines follows index `from`.
function onlyQuotesAfter(lines: string[], from: number): boolean {
  return lines.slice(from).every((line) => isBlank(line) || isQuote(line));
}
export function extractReply(text: string): Extraction {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    const isAttribution = attribution.some((pattern) => pattern.test(line));
    const isHeaderBlock =
      headerStart.test(line) &&
      lines.slice(index + 1, index + 4).some((next) => headerFollow.test(next.trim()));
    // An attribution line ends the new content only if everything after it is
    // the quoted earlier message, or if it introduces an unquoted copy of it
    // (Outlook style) with nothing of the customer's own after it.
    if ((isAttribution || isHeaderBlock) && index > 0) {
      if (onlyQuotesAfter(lines, index + 1) || isHeaderBlock || /^-{2,}|^_{10,}/.test(line)) {
        end = index;
        break;
      }
    }
  }
  let kept = lines.slice(0, end);
  // A signature after the standard delimiter "-- ".
  const signature = kept.findIndex((line) => line === "-- " || line === "--");
  if (signature > 0) kept = kept.slice(0, signature);
  // A trailing block of quoted lines with no reply after it.
  let last = kept.length;
  while (last > 0 && (isBlank(kept[last - 1] ?? "") || isQuote(kept[last - 1] ?? ""))) last -= 1;
  if (last > 0 && last < kept.length && kept.slice(last).some(isQuote)) kept = kept.slice(0, last);
  const markdown = kept.join("\n").trim();
  const original = lines.join("\n").trim();
  if (!markdown) return { markdown: original, trimmed: false };
  return { markdown, trimmed: markdown !== original };
}
