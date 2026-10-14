import { extractBytes } from "./core";
import { limits } from "./types";
// The entry of the process that reads a file. It gets the bytes on its standard
// input and answers with one line of JSON; it has no network, no right to write
// and no environment (see sandbox.ts).
const chunks: Buffer[] = [];
let size = 0;
let refused = false;
for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
  size += chunk.length;
  if (size > limits.inputBytes) {
    refused = true;
    break;
  }
  chunks.push(chunk);
}
const result = refused
  ? { ok: false, reason: "too_large" }
  : await extractBytes(Buffer.concat(chunks));
process.stdout.write(JSON.stringify(result));
process.exit(0);
