import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { capabilities } from "../src/domain/capabilities";
describe("capability source registry", () => {
  it("links every declaration to existing surfaces or an explicit difference", () => {
    const ledger = readFileSync("docs/capabilities.md", "utf8");
    for (const [id, declaration] of Object.entries(capabilities)) {
      expect(ledger).toContain(id);
      for (const file of [declaration.ui, declaration.api, declaration.mcp])
        if (file !== null) expect(existsSync(file)).toBe(true);
      if (declaration.mcp === null) expect(existsSync(declaration.difference)).toBe(true);
    }
  });
  it("rejects domain routes added without a declared capability", () => {
    const registered = new Set(
      Object.values(capabilities).map((declaration) => declaration.operation),
    );
    for (const file of ["src/app/api/v1/[[...path]]/route.ts", "src/server/mcp.ts"]) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
      const imported: string[] = [];
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.endsWith("/operations")
        )
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          imported.push(
            ...bindings.elements.map((element) => (element.propertyName ?? element.name).text),
          );
      }
      expect(imported.length).toBeGreaterThan(0);
      for (const name of imported) expect([...registered]).toContain(name);
    }
  });
});
