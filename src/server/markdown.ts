import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
// The same rules decide what a mail and the desk show, and which links a person
// is shown before a draft goes out.
function options(links?: ReturnType<typeof collector>): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "del",
      "blockquote",
      "ul",
      "ol",
      "li",
      "pre",
      "code",
      "a",
      "h1",
      "h2",
      "h3",
      "h4",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
    ],
    allowedAttributes: { a: ["href", "title", "rel", "target"], code: ["class"] },
    allowedSchemes: ["https", "http", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
    // A link that survived the rules is reported with its text; it stays in the HTML.
    ...(links
      ? {
          exclusiveFilter: (frame: sanitizeHtml.IFrame) => {
            if (frame.tag === "a" && frame.attribs.href) links.add(frame.text, frame.attribs.href);
            return false;
          },
        }
      : {}),
  };
}
const render = (value: string, links?: ReturnType<typeof collector>) =>
  sanitizeHtml(marked.parse(value, { async: false, gfm: true }), options(links));
export function markdownHtml(value: string): string {
  return render(value);
}
export interface MarkdownLink {
  text: string;
  url: string;
  // The host of the address, or null for a mail address.
  host: string | null;
  // The text of the link is itself an address of another host than the one the
  // link goes to, which is how a link is made to look harmless.
  misleading: boolean;
}
const textLimit = 120;
function hostOf(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === "mailto:" ? null : url.hostname.toLowerCase();
  } catch {
    return null;
  }
}
// The host that a link text claims, when the text looks like an address.
function claimedHost(text: string): string | null {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!/^(?:https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#].*)?$/i.test(trimmed)) return null;
  return hostOf(withScheme);
}
function collector() {
  const found: MarkdownLink[] = [];
  return {
    found,
    add(text: string, url: string) {
      const host = hostOf(url);
      const claimed = claimedHost(text);
      const shown = text.replace(/\s+/g, " ").trim();
      const link: MarkdownLink = {
        text: shown.length > textLimit ? `${shown.slice(0, textLimit)}…` : shown,
        url,
        host,
        misleading: claimed !== null && host !== null && claimed !== host,
      };
      if (!found.some((entry) => entry.text === link.text && entry.url === link.url))
        found.push(link);
    },
  };
}
// The links that the mail made of this Markdown will carry, in order, with the
// text a reader sees and the address it goes to.
export function markdownLinks(value: string): MarkdownLink[] {
  const links = collector();
  render(value, links);
  return links.found;
}
