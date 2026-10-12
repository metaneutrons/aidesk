import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { db, sqlClient } from "../src/server/db";
import {
  account,
  user,
  projects,
  memberships,
  tickets,
  messages,
  connections,
} from "../src/server/db/schema";
import { actions } from "../src/domain/permissions";
import { initializeStorage } from "../src/server/storage";
import { ensureDevSso } from "./dev-sso";
if (process.env.DEV_BOOTSTRAP !== "true" || process.env.NODE_ENV !== "development") {
  throw new Error("Development bootstrap is restricted to private development.");
}
const email = process.env.DEV_OWNER_EMAIL;
const password = process.env.DEV_OWNER_PASSWORD;
if (!email || !password || password.length < 16)
  throw new Error("Generated development owner credentials required.");
const database = db();
const existing = await database.select().from(user).where(eq(user.email, email)).limit(1);
if (!existing[0]) {
  const id = randomUUID();
  const hashed = await hashPassword(password);
  await database.transaction(async (tx) => {
    await tx
      .insert(user)
      .values({ id, name: "Development owner", email, emailVerified: true, owner: true });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: hashed,
    });
    for (const [slug, name, color] of [
      ["orbit", "Orbit", "#5972ed"],
      ["harbor", "Harbor", "#c2843c"],
    ]) {
      if (!slug || !name || !color) throw new Error("Invalid seed project");
      const [project] = await tx
        .insert(projects)
        .values({ slug, name, color, settings: { developmentFixture: true } })
        .returning();
      if (!project) throw new Error("Project creation failed");
      await tx
        .insert(memberships)
        .values({ userId: id, projectId: project.id, actions: [...actions] });
      const [outgoing] = await tx
        .insert(connections)
        .values({
          projectId: project.id,
          kind: "smtp",
          name: "Development Mailpit",
          direction: "outbound",
          status: "ready",
          config: {
            host: process.env.DEV_SMTP_HOST ?? "mailpit",
            port: Number(process.env.DEV_SMTP_PORT ?? 1025),
            secure: false,
            from: `${slug}@support.local`,
            replyTo: `${slug}@support.local`,
            developmentOnly: true,
          },
        })
        .returning();
      if (!outgoing) throw new Error("Outbound connection creation failed");
      await tx
        .update(projects)
        .set({ settings: { developmentFixture: true, outboundConnectionId: outgoing.id } })
        .where(eq(projects.id, project.id));
      const [ticket] = await tx
        .insert(tickets)
        .values({
          projectId: project.id,
          subject:
            slug === "orbit"
              ? "Could you help me with the API integration?"
              : "Frage zur Einrichtung meines Projekts",
          requesterEmail: "customer@example.test",
          requesterName: "Alex",
          language: slug === "orbit" ? "en" : "de",
          pendingSince: new Date(Date.now() - (slug === "orbit" ? 26 : 2) * 3_600_000),
        })
        .returning();
      if (!ticket) throw new Error("Ticket creation failed");
      await tx.insert(messages).values({
        ticketId: ticket.id,
        authorType: "customer",
        authorName: "Alex",
        authorEmail: "customer@example.test",
        markdown:
          slug === "orbit"
            ? "Hi! I am connecting our app to the API. Could you explain how to create a scoped token?\n\nThanks for your help."
            : "Hallo! Wie richte ich eine eigene Support-Adresse für mein Projekt ein?",
        language: ticket.language,
      });
    }
  });
  console.log(
    "Development owner and two persisted example projects created. Credentials remain in .env.development.",
  );
} else {
  console.log("Development bootstrap already exists; user settings were preserved.");
}
await initializeStorage();
await ensureDevSso();
const [testDatabase] = await sqlClient()`select 1 from pg_database where datname = 'aidesk_test'`;
if (!testDatabase) await sqlClient()`create database aidesk_test`;
await sqlClient().end();
