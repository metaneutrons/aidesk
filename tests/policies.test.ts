import { describe, expect, it } from "vitest";
import {
  actions,
  allowedProjectIds,
  isAction,
  permits,
  type Principal,
} from "../src/domain/permissions";
import { effectiveLocale, negotiateLocale, resolveLocale } from "../src/domain/locale";
import { responseAge, responseState } from "../src/domain/response-clock";
import { seal, unseal } from "../src/server/crypto";
import { markdownHtml } from "../src/server/markdown";
import { renderEmail } from "../src/server/email";
import { DomainError } from "../src/server/errors";
import english from "../src/i18n/en.json";
import german from "../src/i18n/de.json";
import { validateCatalog } from "../src/domain/catalogs";
import { safeReturnTo } from "../src/domain/navigation";
describe("login destinations", () => {
  it("preserves local ticket links and rejects external, malformed or non-string targets", () => {
    expect(safeReturnTo("/?ticket=123#reply")).toBe("/?ticket=123#reply");
    for (const value of [
      undefined,
      ["/"],
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "//[invalid",
    ])
      expect(safeReturnTo(value)).toBe("/");
  });
});
describe("project authorization", () => {
  const owner: Principal = {
    id: "owner",
    kind: "human",
    active: true,
    owner: true,
    grants: [
      { projectId: "a", actions: ["project.read", "ticket.read"] },
      { projectId: "a", actions: ["project.read"] },
      { projectId: "b", actions: ["ticket.reply"] },
    ],
  };
  it("requires the actual project/action grant even for an owner", () => {
    expect(permits(owner, "a", "ticket.read")).toBe(true);
    expect(permits(owner, "a", "ticket.reply")).toBe(false);
    expect(permits(owner, "hidden", "project.read")).toBe(false);
    expect(allowedProjectIds(owner)).toEqual(["a"]);
    expect(allowedProjectIds(owner, "ticket.reply")).toEqual(["b"]);
  });
  it("revokes discovery and every action for inactive people and agents", () => {
    for (const kind of ["human", "agent"] as const) {
      expect(permits({ ...owner, kind, active: false }, "a", "ticket.read")).toBe(false);
      expect(allowedProjectIds({ ...owner, kind, active: false })).toEqual([]);
    }
    expect(actions.every(isAction)).toBe(true);
    expect(isAction("ticket.destroy")).toBe(false);
  });
});
describe("response obligations", () => {
  const receivedAt = new Date("2026-01-01T00:00:00Z");
  const cycle = { receivedAt, answeredAt: null };
  it("uses the trusted receipt through warning and overdue boundaries", () => {
    expect(responseState(cycle, new Date("2026-01-01T03:59:59Z"))).toBe("pending");
    expect(responseState(cycle, new Date("2026-01-01T04:00:00Z"))).toBe("warning");
    expect(responseState(cycle, new Date("2026-01-02T00:00:00Z"))).toBe("overdue");
    expect(responseState(cycle, new Date("2026-01-01T02:00:00Z"), 1, 2)).toBe("overdue");
  });
  it("clamps clock skew and finishes only with an answer", () => {
    expect(responseAge(cycle, new Date("2025-12-31"))).toBe(0);
    const answered = { ...cycle, answeredAt: new Date("2026-01-01T01:00:00Z") };
    expect(responseAge(answered, receivedAt)).toBeNull();
    expect(responseState(answered, receivedAt)).toBe("answered");
  });
});
describe("locale negotiation", () => {
  it("selects supported languages by preference and quality", () => {
    expect(negotiateLocale("fr, de-DE;q=0.8, en;q=0.4")).toBe("de");
    expect(negotiateLocale("en;q=0.5,de;q=0.9")).toBe("de");
    expect(negotiateLocale("en,de")).toBe("en");
    expect(negotiateLocale("de;q=0,en;q=0.9")).toBe("en");
    expect(negotiateLocale("de;q=NaN,en;q=2")).toBe("en");
    expect(negotiateLocale(null)).toBe("en");
    expect(negotiateLocale("")).toBe("en");
    expect(negotiateLocale("de-DE;foo=bar;q=0.7")).toBe("de");
    expect(resolveLocale("DE_at")).toBe("de");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
  it("prefers a stored choice and otherwise follows the browser", () => {
    expect(effectiveLocale(null, "de-DE,de;q=0.9")).toBe("de");
    expect(effectiveLocale(null, "fr-FR")).toBe("en");
    expect(effectiveLocale(null, null)).toBe("en");
    expect(effectiveLocale("en", "de-DE")).toBe("en");
    expect(effectiveLocale("de", "en-US")).toBe("de");
  });
  it("provides matching, nonempty MVP UI catalogues", () => {
    expect(() => {
      validateCatalog(english, german);
    }).not.toThrow();
    expect(Object.keys(german).sort()).toEqual(Object.keys(english).sort());
    for (const value of [...Object.values(english), ...Object.values(german)])
      expect(value.trim()).not.toBe("");
  });
  it("rejects missing, extra, empty and malformed messages", () => {
    expect(() => {
      validateCatalog({ example: "Hello" }, {});
    }).toThrow("catalog_keys_mismatch");
    expect(() => {
      validateCatalog({}, { extra: "Hello" });
    }).toThrow("catalog_keys_mismatch");
    expect(() => {
      validateCatalog({ example: "Hello" }, { example: " " });
    }).toThrow("empty_catalog_message");
    expect(() => {
      validateCatalog({ example: "Hello" }, { example: "{count, plural, one {Hello}" });
    }).toThrow();
  });
});
describe("secret envelopes", () => {
  const key = "ab".repeat(32);
  it("round trips Unicode and empty secrets with unique nonces", () => {
    const first = seal("Grüße 🔐", key);
    expect(unseal(first, key)).toBe("Grüße 🔐");
    expect(seal("Grüße 🔐", key)).not.toBe(first);
    expect(unseal(seal("", key), key)).toBe("");
  });
  it("rejects invalid keys, malformed envelopes, tampering and wrong keys", () => {
    expect(() => seal("secret", "bad")).toThrow("invalid_encryption_key");
    expect(() => unseal("v1", "bad")).toThrow("invalid_encryption_key");
    for (const value of [
      "",
      "v2:a:b:c",
      "v1::",
      `v1:${"a".repeat(24)}:${"a".repeat(32)}:a`,
      `v1:${"a".repeat(24)}:${"a".repeat(32)}:00:extra`,
    ])
      expect(() => unseal(value, key)).toThrow("invalid_encrypted_value");
    const value = seal("private", key);
    expect(() => unseal(value, "cd".repeat(32))).toThrow();
    const parts = value.split(":");
    parts[3] = "00";
    expect(() => unseal(parts.join(":"), key)).toThrow();
  });
});
describe("communication rendering", () => {
  it("renders Markdown without active content or tracker images", () => {
    const html = markdownHtml(
      '**Hello** [link](https://example.test)\n\n<script>alert(1)</script><img src="https://tracker.test/x"><a href="javascript:alert(1)">bad</a>',
    );
    expect(html).toContain("<strong>Hello</strong>");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });
  it("builds project-specific HTML and text from the same source", async () => {
    const rendered = await renderEmail({
      project: "Harbor <test>",
      markdown: "**Danke** für die Nachricht.",
      language: "de",
      color: "javascript:evil",
    });
    expect(rendered.html).toContain('lang="de"');
    expect(rendered.html).toContain("Harbor &lt;test&gt;");
    expect(rendered.html).toContain("#5668e8");
    expect(rendered.text).toContain("Danke");
    expect(rendered.text).not.toContain("<strong>");
    expect(
      (await renderEmail({ project: "Orbit", markdown: "Hello", language: "en" })).html,
    ).toContain("Orbit");
  });
  it("carries stable domain error codes without customer details", () => {
    const error = new DomainError("forbidden", 403);
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
  });
});
