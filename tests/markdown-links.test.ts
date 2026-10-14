import { describe, expect, it } from "vitest";
import { markdownHtml, markdownLinks } from "../src/server/markdown";
describe("the links of a text, as a person checks them before a draft goes out", () => {
  it("lists a link with its text and address", () => {
    expect(markdownLinks("See the [docs](https://example.test/a?b=1) page.")).toEqual([
      { text: "docs", url: "https://example.test/a?b=1", host: "example.test", misleading: false },
    ]);
    // A bare address is a link whose text is the address.
    expect(markdownLinks("Open https://example.test/p now")).toEqual([
      {
        text: "https://example.test/p",
        url: "https://example.test/p",
        host: "example.test",
        misleading: false,
      },
    ]);
    // Formatting inside the text is not part of it, and a mail address has no host.
    expect(
      markdownLinks("[**bold** words](https://example.test/) and [write](mailto:a@example.test)"),
    ).toEqual([
      { text: "bold words", url: "https://example.test/", host: "example.test", misleading: false },
      { text: "write", url: "mailto:a@example.test", host: null, misleading: false },
    ]);
  });
  it("marks a link whose text is an address of another host", () => {
    const misleading = (text: string) =>
      markdownLinks(`[${text}](https://evil.example/login)`)[0]?.misleading;
    expect(misleading("https://bank.example/login")).toBe(true);
    expect(misleading("bank.example")).toBe(true);
    expect(misleading("www.bank.example/account?x=1")).toBe(true);
    // The same host, a text that is no address, and a text with several words.
    expect(misleading("https://evil.example/other")).toBe(false);
    expect(misleading("EVIL.example")).toBe(false);
    expect(misleading("click here")).toBe(false);
    expect(misleading("bank.example is our bank")).toBe(false);
    expect(misleading("Version 1.2")).toBe(false);
  });
  it("sees an anchor written as HTML in the text as well", () => {
    expect(markdownLinks('Pay at <a href="https://evil.example/pay">paypal.com</a> today')).toEqual(
      [
        {
          text: "paypal.com",
          url: "https://evil.example/pay",
          host: "evil.example",
          misleading: true,
        },
      ],
    );
  });
  it("lists only links that stay in the mail, and an image is neither a link nor an image", () => {
    expect(
      markdownLinks(
        "[x](javascript:alert(1)) [y](data:text/html;base64,AAAA) [z](ftp://example.test/f)",
      ),
    ).toEqual([]);
    const image = "![logo](https://evil.example/p.png?d=SECRET) text";
    expect(markdownLinks(image)).toEqual([]);
    expect(markdownHtml(image)).not.toContain("<img");
    expect(markdownHtml(image)).not.toContain("evil.example");
  });
  it("lists a link once and shortens a long text", () => {
    expect(markdownLinks("[a](https://example.test/) and [a](https://example.test/)")).toHaveLength(
      1,
    );
    const long = markdownLinks(`[${"w".repeat(300)}](https://example.test/)`)[0];
    expect(long?.text).toHaveLength(121);
    expect(long?.text.endsWith("…")).toBe(true);
  });
  it("gives the same HTML as before", () => {
    expect(markdownHtml("a [b](https://example.test/) <script>x</script>")).toBe(
      '<p>a <a href="https://example.test/" rel="noopener noreferrer" target="_blank">b</a> </p>\n',
    );
  });
});
