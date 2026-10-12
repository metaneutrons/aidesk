// Development-only: gives each example project an inbound IMAP connection to
// the GreenMail mailbox of its support address, so mail sent there becomes
// tickets. Runs on every boot and only adds what is missing.
import { and, eq } from "drizzle-orm";
import { db } from "../src/server/db";
import { connections, projects } from "../src/server/db/schema";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
export async function ensureDevMailboxes(): Promise<void> {
  const host = process.env.DEV_IMAP_HOST;
  if (!host) return;
  for (const slug of ["orbit", "harbor"]) {
    const [project] = await db()
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, slug));
    if (!project) continue;
    const [existing] = await db()
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.projectId, project.id),
          eq(connections.kind, "imap"),
          eq(connections.direction, "inbound"),
        ),
      );
    if (existing) continue;
    await db()
      .insert(connections)
      .values({
        projectId: project.id,
        kind: "imap",
        name: "Development GreenMail",
        direction: "inbound",
        status: "ready",
        config: {
          host,
          port: Number(process.env.DEV_IMAP_PORT ?? 3143),
          secure: false,
          user: `${slug}@support.local`,
          mailbox: "INBOX",
          developmentOnly: true,
        },
        secretCiphertext: seal(JSON.stringify({ pass: "development" }), env().ENCRYPTION_KEY),
      });
  }
  console.log("Development mailboxes are connected.");
}
