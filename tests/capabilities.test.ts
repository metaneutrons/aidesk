import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { capabilities } from "../src/domain/capabilities";
import { routes } from "../src/server/api/routes";
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
  it("rejects domain routes added without a declared capability", async () => {
    // Only the operations count; the input schemas the route table imports are
    // values of the same modules but not capabilities.
    const modules = {
      ...(await import("../src/server/operations")),
      ...(await import("../src/server/email-design")),
    } as Record<string, unknown>;
    const registered = new Set(
      Object.values(capabilities).map((declaration) => declaration.operation),
    );
    for (const file of ["src/server/api/routes.ts", "src/server/mcp.ts"]) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
      const imported: string[] = [];
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !["/operations", "/email-design"].some((module) =>
            (statement.moduleSpecifier as ts.StringLiteral).text.endsWith(module),
          )
        )
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          imported.push(
            ...bindings.elements.map((element) => (element.propertyName ?? element.name).text),
          );
      }
      expect(imported.length).toBeGreaterThan(0);
      const callable = imported.filter((name) => typeof modules[name] === "function");
      expect(callable.length).toBeGreaterThan(0);
      for (const name of callable) expect([...registered]).toContain(name);
    }
  });
  it("agrees with the route table on which operations MCP offers", () => {
    const byId = new Map(routes.map((route) => [route.id, route]));
    for (const [id, declaration] of Object.entries(capabilities)) {
      const route = byId.get(id);
      // Capabilities of the customer page have no route in the table.
      if (!route) continue;
      const offered = !("not" in route.mcp);
      expect(declaration.mcp !== null, `${id}: registry and route table differ on MCP`).toBe(
        offered,
      );
    }
    // Every route of the table is declared as a capability, under its own id.
    for (const route of routes) expect(Object.keys(capabilities), route.id).toContain(route.id);
  });
});
