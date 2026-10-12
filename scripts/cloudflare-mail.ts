// Connects a project to Cloudflare mail: inbound through the Email Worker and
// R2 bucket in cloudflare/mail-ingest, outbound through Cloudflare Email
// Sending or an SMTP submission server. Creates the project if its slug is new
// and updates its connections in place, so ingested mail keeps its connection
// and external keys stay stable. Secrets are read from the environment, sealed
// and never printed.
//
//   tsx scripts/cloudflare-mail.ts --project <slug> --name <name> \
//     --address <support address> [--outbound cloudflare|smtp] \
//     [--grant <operator email>]...
//
// --outbound smtp reads SMTP_HOST, SMTP_PORT (default 465, implicit TLS;
// otherwise STARTTLS is required), SMTP_USER and SMTP_PASSWORD.
import { parseArgs } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlClient } from "../src/server/db";
import { connections, memberships, projects, user } from "../src/server/db/schema";
import { actions } from "../src/domain/permissions";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
const { values } = parseArgs({
  options: {
    project: { type: "string" },
    name: { type: "string" },
    address: { type: "string" },
    outbound: { type: "string", default: "cloudflare" },
    grant: { type: "string", multiple: true, default: [] },
  },
});
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const slug = required("--project", values.project);
const address = required("--address", values.address).toLowerCase();
const accountId = required("CLOUDFLARE_ACCOUNT_ID", process.env.CLOUDFLARE_ACCOUNT_ID);
const jurisdiction = process.env.CLOUDFLARE_R2_JURISDICTION ?? "eu";
const bucket = process.env.CLOUDFLARE_R2_BUCKET ?? "aidesk-mail";
const r2Secret = {
  accessKeyId: required("CLOUDFLARE_R2_ACCESS_KEY_ID", process.env.CLOUDFLARE_R2_ACCESS_KEY_ID),
  secretAccessKey: required(
    "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  ),
};
if (values.outbound !== "cloudflare" && values.outbound !== "smtp")
  throw new Error("--outbound must be cloudflare or smtp");
const outboundKind = values.outbound;
function outboundSettings() {
  if (outboundKind === "cloudflare")
    return {
      name: `Cloudflare ${address}`,
      config: { accountId, from: address, replyTo: address },
      secret: {
        apiToken: required("CLOUDFLARE_SENDING_TOKEN", process.env.CLOUDFLARE_SENDING_TOKEN),
      },
    };
  const host = required("SMTP_HOST", process.env.SMTP_HOST);
  const port = Number(process.env.SMTP_PORT ?? 465);
  return {
    name: `SMTP ${host}`,
    config: { host, port, secure: port === 465, from: address, replyTo: address },
    secret: {
      user: required("SMTP_USER", process.env.SMTP_USER),
      pass: required("SMTP_PASSWORD", process.env.SMTP_PASSWORD),
    },
  };
}
const outboundSetup = outboundSettings();
const endpoint =
  jurisdiction === "default"
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;
const key = env().ENCRYPTION_KEY;
const result = await db().transaction(async (tx) => {
  let [project] = await tx.select().from(projects).where(eq(projects.slug, slug));
  if (!project) {
    [project] = await tx
      .insert(projects)
      .values({ slug, name: required("--name", values.name) })
      .returning();
  }
  if (!project) throw new Error("project_creation_failed");
  const upsert = async (
    kind: string,
    name: string,
    direction: "inbound" | "outbound",
    config: object,
    secret: object,
  ) => {
    const values = {
      projectId: project.id,
      kind,
      name,
      direction,
      status: "ready",
      lastErrorCode: null,
      config: { ...config },
      secretCiphertext: seal(JSON.stringify(secret), key),
      updatedAt: new Date(),
    };
    const [existing] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.projectId, project.id),
          eq(connections.kind, kind),
          eq(connections.direction, direction),
        ),
      );
    const [saved] = existing
      ? await tx
          .update(connections)
          .set(values)
          .where(eq(connections.id, existing.id))
          .returning({ id: connections.id })
      : await tx.insert(connections).values(values).returning({ id: connections.id });
    return saved;
  };
  const inbound = await upsert(
    "cloudflare",
    `Cloudflare ${address}`,
    "inbound",
    { endpoint, bucket, address },
    r2Secret,
  );
  const outbound = await upsert(
    outboundKind,
    outboundSetup.name,
    "outbound",
    outboundSetup.config,
    outboundSetup.secret,
  );
  if (!inbound || !outbound) throw new Error("connection_creation_failed");
  await tx
    .update(projects)
    .set({ settings: { ...project.settings, outboundConnectionId: outbound.id } })
    .where(eq(projects.id, project.id));
  const operators = values.grant.length
    ? await tx.select({ id: user.id }).from(user).where(inArray(user.email, values.grant))
    : [];
  if (operators.length !== values.grant.length) throw new Error("operator_missing");
  for (const operator of operators)
    await tx
      .insert(memberships)
      .values({ userId: operator.id, projectId: project.id, actions: [...actions] })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.projectId],
        set: { actions: [...actions] },
      });
  return { projectId: project.id, inbound: inbound.id, outbound: outbound.id };
});
console.log(JSON.stringify(result));
await sqlClient().end();
