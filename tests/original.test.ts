import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import MailComposer from "nodemailer/lib/mail-composer";
import { db, sqlClient } from "../src/server/db";
import { ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { getOriginalPreview, getTicket } from "../src/server/operations";
import { renderOriginal } from "../src/server/original";
import { initializeStorage } from "../src/server/storage";
import type { Principal } from "../src/domain/permissions";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
async function compose(options: object): Promise<Buffer> {
  return new MailComposer({
    from: "Alex <alex@example.test>",
    to: "support@example.test",
    subject: "Original",
    messageId: `<${randomUUID()}@example.test>`,
    ...options,
  })
    .compile()
    .build();
}
describe("original preview rendering", () => {
  it("removes everything that could run or load from the sender's markup", async () => {
    const preview = await renderOriginal(
      await compose({
        html: [
          '<p onclick="alert(1)" style="color:red;background:url(https://evil.test/x)">Hello <b>world</b></p>',
          "<script>window.top.location='https://evil.test'</script>",
          '<img src="https://tracker.test/pixel.gif" onerror="alert(2)" alt="pixel">',
          '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" alt="svg">',
          '<form action="https://evil.test"><input name="x"><button>Send</button></form>',
          '<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="x">',
          '<a href="javascript:alert(3)">js</a> <a href="https://example.test/a">web</a> <a href="mailto:a@b.test">mail</a>',
          '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/">',
          '<link rel="stylesheet" href="https://evil.test/x.css"><style>body{background:url(https://evil.test)}</style>',
          '<svg onload="alert(4)"><circle/></svg><math><mi xlink:href="javascript:alert(5)">x</mi></math>',
          '<div style="position:fixed;top:0;left:0;width:100%;height:100%">overlay</div>',
        ].join(""),
      }),
    );
    const body = preview.html.slice(preview.html.indexOf("<body>"));
    for (const unsafe of [
      "<script",
      "onclick",
      "onerror",
      "<form",
      "<input",
      "<iframe",
      "<object",
      "<embed",
      "<svg",
      "<math",
      '<meta http-equiv="refresh',
      "<base",
      "<link",
      "<style",
      "javascript:",
      "tracker.test",
      "evil.test/x",
      "data:image/svg",
      "position:",
      "url(",
    ])
      expect(body, unsafe).not.toContain(unsafe);
    // Formatting and safe links stay.
    expect(body).toContain("<b>world</b>");
    expect(body).toContain('href="https://example.test/a"');
    expect(body).toContain('rel="noopener noreferrer"');
    expect(body).toContain('href="mailto:a@b.test"');
    expect(body).toContain("color:red");
    // The frame carries its own policy that admits data images only.
    expect(preview.html).toContain("Content-Security-Policy");
    expect(preview.html).toContain("default-src 'none'");
    expect(preview.html).toContain("img-src data:");
    expect(preview.remoteImagesBlocked).toBe(2);
    expect(preview.text).toContain("Hello world");
  });
  it("shows the images that the mail carries and nothing else", async () => {
    const preview = await renderOriginal(
      await compose({
        html: '<p>Logo <img src="cid:logo@example.test" alt="logo"> and <img src="cid:missing@example.test" alt="gone"> and <img src="cid:doc@example.test" alt="doc"></p>',
        attachments: [
          {
            filename: "logo.png",
            content: png,
            cid: "logo@example.test",
            contentType: "image/png",
          },
          {
            filename: "doc.svg",
            content: Buffer.from("<svg onload=alert(1)></svg>"),
            cid: "doc@example.test",
            contentType: "image/svg+xml",
          },
          { filename: "report.pdf", content: Buffer.from("pdf"), contentType: "application/pdf" },
        ],
      }),
    );
    expect(preview.html).toContain('src="data:image/png;base64,');
    expect(preview.html).not.toContain("svg+xml");
    expect(preview.html).not.toContain("cid:");
    expect(preview.remoteImagesBlocked).toBe(2);
    expect(preview.attachments).toBe(1);
  });
  it("limits the size of embedded images", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    const preview = await renderOriginal(
      await compose({
        html: '<img src="cid:big@example.test" alt="big">',
        attachments: [
          { filename: "big.png", content: big, cid: "big@example.test", contentType: "image/png" },
        ],
      }),
    );
    expect(preview.html).not.toContain("data:image");
    expect(preview.remoteImagesBlocked).toBe(1);
  });
  it("falls back to the plain text and escapes it", async () => {
    const plain = await renderOriginal(await compose({ text: "Line <b>one</b>\nTwo & three" }));
    expect(plain.html).toContain("<pre>Line &lt;b&gt;one&lt;/b&gt;\nTwo &amp; three");
    expect(plain.text).toBe("Line <b>one</b>\nTwo & three");
    expect(plain.subject).toBe("Original");
    expect(plain.from).toContain("alex@example.test");
    const htmlOnly = await renderOriginal(
      Buffer.from(
        "From: a@example.test\r\nSubject: x\r\nContent-Type: text/html\r\n\r\n<p>Only <i>html</i></p>\r\n",
      ),
    );
    expect(htmlOnly.text).toBe("Only html");
    expect(htmlOnly.date).toBeNull();
    const bare = await renderOriginal(Buffer.from("Subject: s\r\n\r\n"));
    expect(bare.from).toBe("");
  });
});
const projectId = randomUUID();
const otherProject = randomUUID();
const reader: Principal = {
  id: `reader-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
describe("original preview access", () => {
  beforeAll(async () => {
    await migrate(db(), { migrationsFolder: "drizzle" });
    await initializeStorage();
    await db()
      .insert(projects)
      .values([
        { id: projectId, name: "Original", slug: `original-${projectId}` },
        { id: otherProject, name: "Other", slug: `original-${otherProject}` },
      ]);
  });
  afterAll(async () => {
    const ids = [projectId, otherProject];
    await db().delete(jobs).where(inArray(jobs.projectId, ids));
    await db().delete(ingress).where(inArray(ingress.projectId, ids));
    await db().delete(tickets).where(inArray(tickets.projectId, ids));
    await db().delete(projects).where(inArray(projects.id, ids));
    await sqlClient().end();
  });
  it("is served for the stored original to readers of the project only", async () => {
    const { ingressId } = await acceptInbound({
      projectId,
      connectionId: null,
      externalKey: `test:${randomUUID()}`,
      raw: await compose({ html: "<p>Stored <script>alert(1)</script>original</p>" }),
    });
    await processIngress(ingressId);
    const [row] = await db().select().from(messages);
    const target = (
      await db()
        .select()
        .from(messages)
        .innerJoin(tickets, (await import("drizzle-orm")).eq(tickets.id, messages.ticketId))
        .where((await import("drizzle-orm")).eq(tickets.projectId, projectId))
    )[0]?.message;
    expect(row).toBeDefined();
    const messageId = target?.id ?? "";
    const preview = await getOriginalPreview(reader, messageId);
    expect(preview.html).toContain("Stored");
    expect(preview.html).not.toContain("<script");
    const ticketId = target?.ticketId ?? "";
    expect((await getTicket(reader, ticketId)).messages[0]?.hasOriginal).toBe(true);
    const outsider: Principal = {
      ...reader,
      grants: [{ projectId: otherProject, actions: ["ticket.read"] }],
    };
    await expect(getOriginalPreview(outsider, messageId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getOriginalPreview({ ...reader, grants: [] }, messageId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getOriginalPreview(reader, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getOriginalPreview(reader, "nope")).rejects.toThrow();
  });
});
