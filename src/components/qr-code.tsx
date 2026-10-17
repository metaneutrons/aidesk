import { renderSVG } from "uqr";
// A QR code made here from the text, so that what it holds (a secret) is sent to no service. It has
// a text alternative; the text itself is not in the picture as readable text.
export function QrCode({ value, label }: { value: string; label: string }) {
  return (
    <div
      className="setup-qr"
      role="img"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: renderSVG(value, { border: 2 }) }}
    />
  );
}
