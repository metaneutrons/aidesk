// A check that the image can do what it is for without a database or a network: the
// reader of documents runs in a closed process of Node's permission model, which needs
// /bin/sh, a Node with that model and a place to write the reader to.
//   node_modules/.bin/tsx scripts/smoke.ts
import { strToU8, zipSync } from "fflate";
import { extractSandboxed } from "../src/server/extract/sandbox";
const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const text = "Text of the smoke test";
const docx = zipSync(
  {
    "[Content_Types].xml": strToU8(`${head}<Types/>`),
    "word/document.xml": strToU8(
      `${head}<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  },
  { level: 0 },
);
const result = await extractSandboxed(docx);
if (!result.ok || !result.text.includes(text)) {
  console.error(JSON.stringify(result));
  process.exit(1);
}
console.log(`smoke ok: ${JSON.stringify(result.text.trim())}`);
