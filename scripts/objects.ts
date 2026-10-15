// Copies the objects of the storage to a directory and back.
//   node_modules/.bin/tsx scripts/objects.ts export <directory>
//   node_modules/.bin/tsx scripts/objects.ts import <directory>
import { exportObjects, importObjects } from "../src/server/object-transfer";
const [command, directory] = process.argv.slice(2);
if ((command !== "export" && command !== "import") || !directory) {
  console.error("Usage: objects.ts export|import <directory>");
  process.exit(2);
}
const result = await (command === "export" ? exportObjects(directory) : importObjects(directory));
console.log(JSON.stringify({ command, ...result }));
