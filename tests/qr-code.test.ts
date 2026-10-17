import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import jsQR from "jsqr";
import { QrCode } from "../src/components/qr-code";
// The QR code of the owner setup holds the address that an authenticator app adds as a key.
const uri =
  "otpauth://totp/aidesk%3Aowner%40example.test?secret=ORHW43LWM42GWWKOKJCE2VLDO43VSVLJ&issuer=aidesk&digits=6&period=30";
// What a camera would see: the dark squares of the picture on a light ground, as pixels.
function picture(markup: string, scale = 4) {
  const cells = Number(/viewBox="0 0 (\d+) \d+"/.exec(markup)?.[1]) / 10;
  const size = cells * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const square of markup.matchAll(/M(\d+),(\d+)h10v10h-10z/g)) {
    const x = Number(square[1]) / 10;
    const y = Number(square[2]) / 10;
    for (let dy = 0; dy < scale; dy += 1)
      for (let dx = 0; dx < scale; dx += 1) {
        const at = ((y * scale + dy) * size + x * scale + dx) * 4;
        data[at] = data[at + 1] = data[at + 2] = 0;
      }
  }
  return { data, size };
}
const markupOf = (value: string, label = "QR code with the key") =>
  renderToStaticMarkup(createElement(QrCode, { value, label }));
describe("the QR code of the owner setup", () => {
  it("holds the address, which a reader gives back from the picture that the component makes", () => {
    const { data, size } = picture(markupOf(uri));
    expect(jsQR(data, size, size)?.data).toBe(uri);
  });
  it("is a picture with a text alternative, and the secret is not in the markup as text", () => {
    const html = markupOf(uri);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="QR code with the key"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("ORHW43LW");
  });
  it("differs for another key", () => {
    const other = uri.replace("ORHW43LW", "AAAAAAAA");
    const { data, size } = picture(markupOf(other));
    expect(jsQR(data, size, size)?.data).toBe(other);
    expect(markupOf(other)).not.toBe(markupOf(uri));
  });
});
