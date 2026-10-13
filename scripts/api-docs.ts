import { writeFileSync } from "node:fs";
import { openApiDocument } from "../src/server/api/openapi";
// Writes the committed copy of the published API definition. The test suite
// compares it with the generated one, so a change of the API is a visible diff.
writeFileSync("docs/api/openapi.json", `${JSON.stringify(openApiDocument(), null, 2)}\n`);
