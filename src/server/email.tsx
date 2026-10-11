import { render, toPlainText } from "@react-email/render";
import { markdownHtml } from "./markdown";
export async function renderEmail({
  project,
  markdown,
  language,
  color = "#5668e8",
}: {
  project: string;
  markdown: string;
  language: string;
  color?: string;
}): Promise<{ html: string; text: string }> {
  const accent = /^#[0-9a-f]{6}$/i.test(color) ? color : "#5668e8";
  const html = await render(
    <html lang={language}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
      </head>
      <body
        style={{
          margin: 0,
          padding: "32px 12px",
          backgroundColor: "#f6f7fb",
          color: "#202333",
          fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif",
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
                        {project}
                      </td>
                    </tr>
                    <tr>
                      <td
                        style={{ padding: "28px 32px", fontSize: 15, lineHeight: "1.7" }}
                        dangerouslySetInnerHTML={{ __html: markdownHtml(markdown) }}
                      />
                    </tr>
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
