// Development-only: feeds a raw RFC 822 message from stdin into a project's
// inbound pipeline, as an adapter would.
//   sh scripts/dev.sh exec -T app pnpm exec tsx scripts/dev-inbound.ts <project-slug> < mail.eml
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sqlClient } from "../src/server/db";
import { projects } from "../src/server/db/schema";
import { acceptInbound } from "../src/server/inbound";
if (process.env.DEV_BOOTSTRAP !== "true" || process.env.NODE_ENV !== "development")
  throw new Error("Manual inbound delivery is restricted to private development.");
const slug = process.argv[2];
if (!slug) throw new Error("Usage: dev-inbound.ts <project-slug> < mail.eml");
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
try {
  const [project] = await db()
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug));
  if (!project) throw new Error(`Unknown project ${slug}.`);
  const result = await acceptInbound({
    projectId: project.id,
    connectionId: null,
    externalKey: `dev:${randomUUID()}`,
    raw: Buffer.concat(chunks),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await sqlClient().end();
}
