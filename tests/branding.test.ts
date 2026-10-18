import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, portalBranding, projects, tickets } from "../src/server/db/schema";
import {
  brandingOfPage,
  getBranding,
  readLogo,
  readPortalLogo,
  removeLogo,
  setBranding,
  setLogo,
} from "../src/server/branding";
import { issuePortalGrant } from "../src/server/portal";
import { brandingInput, logoMaxBytes, sniffImage, textOn } from "../src/domain/branding";
import { deleteObjects, getObject, initializeStorage, listObjects } from "../src/server/storage";
import { DomainError } from "../src/server/errors";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectA = randomUUID();
const projectB = randomUUID();
const everything: Action[] = [
  "project.read",
  "ticket.read",
  "ticket.reply",
  "config.read",
  "config.write",
];
const person = (project: string, held: Action[] = everything): Principal => ({
  id: `branding-${run}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const manager = person(projectA);
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
// The first bytes of the three kinds of image, followed by something, which is all that the sniffing looks at.
const png = (tail = "a") =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]);
const webp = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([1, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
]);
const logo = (bytes: Buffer) => ({ data: bytes.toString("base64") });
const keysOf = async (project: string) => {
  const found: string[] = [];
  for await (const entry of listObjects(`branding/${project}/`)) found.push(entry.key);
  return found;
};
const entries = (action: string, project = projectA) =>
  db()
    .select()
    .from(audit)
    .where(and(eq(audit.projectId, project), eq(audit.action, action)));
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectA, name: "Brand A", slug: `brand-a-${run}` },
      { id: projectB, name: "Brand B", slug: `brand-b-${run}` },
    ]);
});
afterAll(async () => {
  for (const project of [projectA, projectB]) await deleteObjects(await keysOf(project));
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectA, projectB]));
  await db()
    .delete(tickets)
    .where(inArray(tickets.projectId, [projectA, projectB]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectA, projectB]));
  await sqlClient().end();
});
describe("the kinds of image that are taken", () => {
  it("knows a PNG, a JPEG and a WebP by their first bytes, and nothing else", () => {
    expect(sniffImage(png())).toBe("image/png");
    expect(sniffImage(jpeg)).toBe("image/jpeg");
    expect(sniffImage(webp)).toBe("image/webp");
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffImage(Buffer.from("<html><script>1</script>"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    // RIFF alone is a WAV or an AVI, and each of the four letters of WEBP counts.
    for (const form of ["AVI LIST", "XEBPVP8 ", "WXBPVP8 ", "WEXPVP8 ", "WEBXVP8 "])
      expect(
        sniffImage(
          Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from(form)]),
        ),
        form,
      ).toBeNull();
    // RIFF alone is a WAV or an AVI.
    expect(
      sniffImage(
        Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WAVEfmt ")]),
      ),
    ).toBeNull();
  });
});
describe("the text on a colour", () => {
  it("is black on a light colour and white on a dark one, and has a contrast of at least 4.5 on any", () => {
    expect(textOn("#ffffff")).toBe("#000000");
    expect(textOn("#000000")).toBe("#ffffff");
    expect(textOn("#ffff00")).toBe("#000000");
    expect(textOn("#0000ff")).toBe("#ffffff");
    const luminance = (hex: string) => {
      const channel = (offset: number) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    for (let red = 0; red < 256; red += 51)
      for (let green = 0; green < 256; green += 51)
        for (let blue = 0; blue < 256; blue += 51) {
          const colour = `#${[red, green, blue].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
          const [a, b] = [luminance(colour), luminance(textOn(colour))].sort((x, y) => y - x);
          expect(((a ?? 0) + 0.05) / ((b ?? 0) + 0.05), colour).toBeGreaterThanOrEqual(4.5);
        }
  });
});
describe("what is set for the page", () => {
  it("is set, read back, and removed field by field; a field that is left out stays", async () => {
    expect(await getBranding(manager, projectA)).toMatchObject({
      displayName: null,
      accentColor: null,
      language: null,
      hasLogo: false,
      updatedAt: null,
    });
    const set = await setBranding(manager, projectA, {
      displayName: "  Example Support  ",
      headerText: "We answer within a day.",
      accentColor: "#AA3355",
      language: "de",
    });
    expect(set).toMatchObject({
      displayName: "Example Support",
      headerText: "We answer within a day.",
      accentColor: "#aa3355",
      language: "de",
    });
    expect(await setBranding(manager, projectA, { headerText: "" })).toMatchObject({
      displayName: "Example Support",
      headerText: null,
      accentColor: "#aa3355",
    });
    expect(
      await setBranding(manager, projectA, { accentColor: null, language: null }),
    ).toMatchObject({
      accentColor: null,
      language: null,
      displayName: "Example Support",
    });
    expect(await brandingOfPage(projectA)).toMatchObject({ displayName: "Example Support" });
    expect(await brandingOfPage(projectB)).toMatchObject({ displayName: null });
  });
  it("refuses a colour that is not six hexadecimal digits, a language that is not offered, a text that is too long, a field that is not known and nothing", () => {
    for (const input of [
      { accentColor: "red" },
      { accentColor: "#fff" },
      { accentColor: "#12345g" },
      { accentColor: "rgb(0,0,0)" },
      { language: "fr" },
      { displayName: "x".repeat(81) },
      { headerText: "x".repeat(301) },
      { logo: "x" },
      {},
    ])
      expect(brandingInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
  it("is written to the audit with the names of the fields and not their text", async () => {
    await setBranding(manager, projectA, { displayName: "Secret Brand Name" });
    const found = await entries("portal_branding.update");
    expect(found.length).toBeGreaterThan(0);
    expect(JSON.stringify(found)).not.toContain("Secret Brand Name");
    expect(found.at(-1)?.detail).toEqual({ fields: ["displayName"] });
  });
  it("is set by a person who may change the configuration, read by one who may read it, and by nobody else", async () => {
    const reader = person(projectA, ["project.read", "config.read"]);
    expect(await outcome(getBranding(reader, projectA))).toBe("ok");
    expect(await outcome(setBranding(reader, projectA, { displayName: "X" }))).toBe("forbidden");
    expect(await outcome(setLogo(reader, projectA, logo(png())))).toBe("forbidden");
    const without = person(projectA, ["project.read"]);
    expect(await outcome(getBranding(without, projectA))).toBe("not_found");
    expect(await outcome(getBranding(person(projectB), projectA))).toBe("not_found");
    expect(await outcome(setBranding(person(projectB), projectA, { displayName: "X" }))).toBe(
      "not_found",
    );
    const agent: Principal = { ...manager, kind: "agent" };
    expect(await outcome(setBranding(agent, projectA, { displayName: "X" }))).toBe("forbidden");
    expect(await outcome(setLogo(agent, projectA, logo(png())))).toBe("forbidden");
    expect(
      await outcome(setBranding({ ...manager, active: false }, projectA, { displayName: "X" })),
    ).toBe("not_found");
  });
});
describe("the logo", () => {
  it("is stored under its hash, shown back, and replaced by another one that removes the old object", async () => {
    const first = await setLogo(manager, projectA, logo(png("one")));
    expect(first.hasLogo).toBe(true);
    const keys = await keysOf(projectA);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^branding/${projectA}/[0-9a-f]{64}$`));
    const shown = await readLogo(manager, projectA);
    expect(shown.type).toBe("image/png");
    expect(shown.content.equals(png("one"))).toBe(true);
    await setLogo(manager, projectA, logo(jpeg));
    const after = await keysOf(projectA);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(keys[0]);
    expect((await readLogo(manager, projectA)).type).toBe("image/jpeg");
    // The same image again changes nothing and loses nothing.
    await setLogo(manager, projectA, logo(jpeg));
    expect(await keysOf(projectA)).toEqual(after);
    expect((await readLogo(manager, projectA)).content.equals(jpeg)).toBe(true);
  });
  it("is refused when it is not an image of a kind that is taken, whatever it says it is, when it is too large and when it is not base64", async () => {
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      Buffer.from("GIF89a....."),
      Buffer.from("MZ executable"),
    ])
      expect(await outcome(setLogo(manager, projectA, logo(bytes)))).toBe(
        "attachment_type_blocked",
      );
    // One byte over the limit is refused by the rule, much more by the size of the request.
    expect(await outcome(setLogo(manager, projectA, logo(png("x".repeat(logoMaxBytes - 7)))))).toBe(
      "attachment_too_large",
    );
    await expect(
      setLogo(manager, projectA, logo(png("x".repeat(logoMaxBytes * 2)))),
    ).rejects.toThrow();
    // The limit itself is allowed; the next test starts from the JPEG again.
    expect(await outcome(setLogo(manager, projectA, logo(png("x".repeat(logoMaxBytes - 8)))))).toBe(
      "ok",
    );
    await setLogo(manager, projectA, logo(jpeg));
    for (const data of ["not base64!", "abc", "a b c d"])
      expect(await outcome(setLogo(manager, projectA, { data }))).toBe("invalid_input");
    await expect(setLogo(manager, projectA, { data: "" })).rejects.toThrow();
    await expect(setLogo(manager, projectA, { data: "AAAA", extra: 1 })).rejects.toThrow();
    // What was set stays.
    expect((await readLogo(manager, projectA)).type).toBe("image/jpeg");
  });
  it("is served to the link of a ticket of the project, and only the logo of that project", async () => {
    const [ticketA] = await db()
      .insert(tickets)
      .values({
        projectId: projectA,
        subject: "A",
        requesterEmail: "a@example.test",
        requesterName: "A",
      })
      .returning({ id: tickets.id });
    const [ticketB] = await db()
      .insert(tickets)
      .values({
        projectId: projectB,
        subject: "B",
        requesterEmail: "b@example.test",
        requesterName: "B",
      })
      .returning({ id: tickets.id });
    const linkA = await issuePortalGrant(manager, ticketA?.id ?? "");
    const linkB = await issuePortalGrant(person(projectB), ticketB?.id ?? "");
    const served = await readPortalLogo(linkA.token, null);
    expect(served.type).toBe("image/jpeg");
    expect(served.content.equals(jpeg)).toBe(true);
    // Project B has no logo, and A's link does not give B's page A's.
    expect(await outcome(readPortalLogo(linkB.token, null))).toBe("not_found");
    expect(await outcome(readPortalLogo("not-a-token", null))).toBe("not_found");
    expect(await outcome(readPortalLogo(undefined, null))).toBe("not_found");
    expect(
      await outcome(readPortalLogo(linkA.token, { kind: "project", projectId: projectB })),
    ).toBe("not_found");
    expect(
      await outcome(readPortalLogo(linkA.token, { kind: "project", projectId: projectA })),
    ).toBe("ok");
  });
  it("is removed with its object, and the entries name the type and the hash, never the image", async () => {
    const removed = await removeLogo(manager, projectA);
    expect(removed.hasLogo).toBe(false);
    expect(await keysOf(projectA)).toEqual([]);
    expect(await outcome(readLogo(manager, projectA))).toBe("not_found");
    // Removing nothing is not an error.
    expect((await removeLogo(manager, projectA)).hasLogo).toBe(false);
    const set = await entries("portal_branding.logo_set");
    expect(set.length).toBeGreaterThan(0);
    // The entries have no order of their own; each names its type and a hash, and the first logo was a PNG.
    for (const entry of set)
      expect(entry.detail).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(set.map((entry) => (entry.detail as { type: string }).type)).toContain("image/png");
    expect((await entries("portal_branding.logo_remove")).length).toBe(1);
    await expect(getObject(`branding/${projectA}/${"0".repeat(64)}`)).rejects.toThrow();
  });
  it("names the logo in the row of the branding, which is what keeps the sweep from removing it", async () => {
    await setLogo(manager, projectA, logo(webp));
    const [row] = await db()
      .select()
      .from(portalBranding)
      .where(eq(portalBranding.projectId, projectA));
    expect(row?.logoKey).toMatch(/^branding\//);
    expect(row?.logoType).toBe("image/webp");
  });
});
