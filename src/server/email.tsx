import { render, toPlainText } from "@react-email/render";
import { markdownHtml } from "./markdown";
import {
  defaultDesign,
  fontStacks,
  localized,
  type EmailDesignConfig,
} from "../domain/email-design";
// Recorded with every sent message, so a later change of the template is
// recognisable next to the mail that was actually sent.
export const emailTemplateVersion = 1;
const mono = "SFMono-Regular,Menlo,Consolas,monospace";
// Mail clients drop or ignore style sheets, so code formatting is inlined.
function mailHtml(markdown: string): string {
  return markdownHtml(markdown)
    .replaceAll(
      /<pre>/g,
      `<pre class="mail-pre" style="margin:0 0 16px;padding:12px 14px;background:#f6f7fb;border:1px solid #e3e5ee;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-family:${mono};font-size:13px;line-height:1.5">`,
    )
    .replaceAll(
      /(?<!<pre[^>]*>)<code(?=[ >])/g,
      `<code class="mail-code" style="padding:1px 4px;background:#f1f2f7;border-radius:4px;font-family:${mono};font-size:13px"`,
    );
}
// Programs that follow the system appearance get a dark variant; others show
// the inline light colors. Rules need !important to win over inline styles.
const darkMode =
  "@media (prefers-color-scheme: dark){.bg{background-color:#14151c!important}.card{background-color:#1d1f2a!important;border-color:#2e3142!important;color:#e6e8f2!important}.txt{color:#e6e8f2!important}.foot{color:#9aa0b8!important;border-color:#2e3142!important}.mail-pre{background-color:#14151c!important;border-color:#2e3142!important}.mail-code{background-color:#14151c!important}a{color:#9aa8ff!important}}";
export async function renderEmail({
  project,
  markdown,
  language,
  color = "#5668e8",
  design = defaultDesign,
  fallbackLanguage = "en",
}: {
  project: string;
  markdown: string;
  language: string;
  color?: string;
  design?: EmailDesignConfig;
  fallbackLanguage?: string;
}): Promise<{ html: string; text: string }> {
  const requested = design.accent ?? color;
  const accent = /^#[0-9a-f]{6}$/i.test(requested) ? requested : "#5668e8";
  const signature = localized(design.signature, language, fallbackLanguage);
  const footer = localized(design.footer, language, fallbackLanguage);
  const body = signature ? `${markdown}\n\n---\n\n${signature}` : markdown;
  const html = await render(
    <html lang={language}>
      <head>
        <meta charSet="utf-8" />
        <title>{design.headerText ?? project}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{darkMode}</style>
      </head>
      <body
        className="bg"
        style={{
          margin: 0,
          padding: "32px 12px",
          backgroundColor: "#f6f7fb",
          color: "#202333",
          fontFamily: fontStacks[design.fontFamily],
        }}
      >
        <table role="presentation" width="100%" cellPadding="0" cellSpacing="0">
          <tbody>
            <tr>
              <td align="center">
                <table
                  role="presentation"
                  width="560"
                  cellPadding="0"
                  cellSpacing="0"
                  className="card"
                  style={{
                    maxWidth: "100%",
                    backgroundColor: "#ffffff",
                    borderRadius: 12,
                    border: "1px solid #e3e5ee",
                  }}
                >
                  <tbody>
                    <tr>
                      <td
                        style={{
                          padding: "24px 32px",
                          borderBottom: `3px solid ${accent}`,
                          fontWeight: 600,
                          fontSize: 18,
                        }}
                      >
                        {design.logoUrl ? (
                          <img
                            src={design.logoUrl}
                            alt={design.headerText ?? project}
                            height={40}
                            style={{ display: "block", height: 40, border: 0 }}
                          />
                        ) : (
                          (design.headerText ?? project)
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td
                        className="txt"
                        style={{ padding: "28px 32px", fontSize: 15, lineHeight: "1.7" }}
                        dangerouslySetInnerHTML={{ __html: mailHtml(body) }}
                      />
                    </tr>
                    {footer && (
                      <tr>
                        <td
                          className="foot"
                          style={{
                            padding: "16px 32px",
                            borderTop: "1px solid #e3e5ee",
                            color: "#6b7085",
                            fontSize: 12,
                            lineHeight: "1.6",
                          }}
                        >
                          {footer}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>,
  );
  return { html, text: toPlainText(html) };
}
