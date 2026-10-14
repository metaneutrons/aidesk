import { extractOoxml } from "./ooxml";
import { extractPdf } from "./pdf";
import { limits, type Extraction } from "./types";
const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);
// What a file is follows from its content and not from the name or type the
// sender gave it. An old binary Office file and a password protected one share a
// container (OLE), which is not read.
export async function extractBytes(bytes: Uint8Array): Promise<Extraction> {
  if (bytes.length > limits.inputBytes) return { ok: false, reason: "too_large" };
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (head.includes("%PDF-")) return extractPdf(bytes);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))
    return extractOoxml(bytes);
  return { ok: false, reason: "unsupported" };
}
