import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
// A view of a received original for people who may read the ticket. The
// sender controls the content, so nothing of it is trusted: markup is reduced
// to a fixed set of formatting tags, scripts, forms, frames, styles and
// event handlers are removed, links keep only web and mail addresses, remote
// images are not loaded and only images that the mail itself carries (cid:)
// are shown, as data. The result is shown in a sandboxed frame without
// scripts, whose own policy admits nothing but those data images.
const tags = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "center",
  "code",
  "col",
  "colgroup",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];
const color = [
  /^#[0-9a-f]{3,8}$/i,
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/i,
  /^[a-z]{3,20}$/i,
];
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxImageBytes = 2 * 1024 * 1024;
const maxImageTotal = 6 * 1024 * 1024;
export interface OriginalPreview {
  subject: string;
  from: string;
  date: string | null;
  // A complete document for a sandboxed frame.
  html: string;
  text: string;
  remoteImagesBlocked: number;
  attachments: number;
}
const policy =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function address(value: { text?: string } | { text?: string }[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.text ?? "";
}
export async function renderOriginal(raw: Buffer): Promise<OriginalPreview> {
  // The parser must keep cid: references; its own replacement would embed any
  // attachment, whatever its type, as a data address.
  const mail = await simpleParser(raw, { keepCidLinks: true });
  // Images that the mail carries, by Content-ID, within limits.
  const inline = new Map<string, string>();
  let total = 0;
  for (const file of mail.attachments) {
    const type = (file.contentType || "").toLowerCase();
    if (!file.cid || !imageTypes.has(type) || file.content.length > maxImageBytes) continue;
    if (total + file.content.length > maxImageTotal) continue;
    total += file.content.length;
    inline.set(
      file.cid.replace(/^<|>$/g, ""),
      `data:${type};base64,${file.content.toString("base64")}`,
    );
  }
  let blocked = 0;
  const source =
    typeof mail.html === "string" && mail.html.trim()
      ? mail.html
      : `<pre>${escapeText(mail.text ?? "")}</pre>`;
  const body = sanitizeHtml(source, {
    allowedTags: tags,
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan", "align", "valign", "width"],
      th: ["colspan", "rowspan", "align", "valign", "width"],
      table: ["width", "align", "cellpadding", "cellspacing", "border"],
      "*": ["style", "dir", "lang"],
    },
    allowedStyles: {
      "*": {
        color,
        "background-color": color,
        "font-weight": [/^(bold|normal|[1-9]00)$/],
        "font-style": [/^(italic|normal)$/],
        "text-align": [/^(left|right|center|justify)$/],
        "text-decoration": [/^(none|underline|line-through)$/],
        "font-size": [/^\d+(\.\d+)?(px|pt|em|%)$/],
      },
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
      img: (tagName, attribs) => {
        const cid = /^cid:(.+)$/i.exec(attribs.src ?? "")?.[1];
        const data = cid ? inline.get(cid.replace(/^<|>$/g, "")) : undefined;
        if (!data) blocked += 1;
        return {
          tagName,
          attribs: { ...(data ? { src: data } : {}), alt: attribs.alt ?? "" },
        };
      },
    },
  });
  let text = mail.text?.trim() ?? "";
  if (!text)
    text = sanitizeHtml(typeof mail.html === "string" ? mail.html : "", {
      allowedTags: [],
      allowedAttributes: {},
    }).trim();
  return {
    subject: (mail.subject ?? "").trim(),
    from: address(mail.from),
    date: mail.date?.toISOString() ?? null,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="color-scheme" content="light"><style>body{margin:12px;font:14px/1.5 sans-serif;color:#202333;background:#fff;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${body}</body></html>`,
    text,
    remoteImagesBlocked: blocked,
    attachments: mail.attachments.filter((file) => !file.cid).length,
  };
}
