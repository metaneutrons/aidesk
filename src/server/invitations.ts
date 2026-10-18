import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { invitationInput, invitationsPerDay } from "../domain/invitations";
import { isAction, permits, type Action, type Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, jobs, memberships, projects, ssoProvider, user } from "./db/schema";
import { DomainError } from "./errors";
import { workspaceControls } from "./controls";
// A person who manages a project adds an operator by address. An address that belongs to nobody gets an account (as
// when an owner adds an operator), and one that belongs to an operator gets the rights added to what they hold, never
// less. Nobody gives more than they hold. The mail is a `mail.test` job with an invitation (see the worker): it goes
// out through the outbound connection of the project and is checked again when it is sent.
const id = z.uuid();
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
export async function inviteOperator(principal: Principal, projectId: string, input: unknown) {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.manage")) throw new DomainError("not_found", 404);
  const values = invitationInput.parse(input);
  const held =
    principal.grants.find((grant) => grant.projectId === project)?.actions ?? ([] as Action[]);
  for (const action of values.actions)
    if (!isAction(action) || !held.includes(action)) throw new DomainError("forbidden", 403);
  if (values.actions.length === 0) throw new DomainError("invalid_input", 400);
  const email = values.email.toLowerCase();
  const [row] = await db().select().from(projects).where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  const [inviter] = await db()
    .select({ name: user.name, displayName: user.displayName })
    .from(user)
    .where(eq(user.id, principal.id));
  const language = values.language ?? (row.defaultLanguage === "de" ? "de" : "en");
  const connectionId = row.settings.outboundConnectionId;
  const mail: "queued" | "skipped" | "no_connection" | "paused" = !values.sendMail
    ? "skipped"
    : typeof connectionId !== "string"
      ? "no_connection"
      : row.settings.pauseOutgoing === true || (await workspaceControls()).pauseOutgoing
        ? "paused"
        : "queued";
  const [verified] = await db()
    .select({ id: ssoProvider.id })
    .from(ssoProvider)
    .where(and(eq(ssoProvider.domain, domainOf(email)), eq(ssoProvider.domainVerified, true)))
    .limit(1);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invite:${project}`}))`);
    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(audit)
      .where(
        and(
          eq(audit.projectId, project),
          eq(audit.action, "operator.invite"),
          gt(audit.createdAt, sql`now() - interval '1 day'`),
        ),
      );
    if ((recent?.count ?? 0) >= invitationsPerDay) throw new DomainError("rate_limited", 429);
    const [existing] = await tx.select().from(user).where(eq(user.email, email));
    if (existing && !existing.active) throw new DomainError("conflict", 409);
    const personId = existing?.id ?? randomUUID();
    if (!existing)
      await tx.insert(user).values({ id: personId, name: values.name, email, emailVerified: true });
    const [current] = await tx
      .select({ actions: memberships.actions })
      .from(memberships)
      .where(and(eq(memberships.userId, personId), eq(memberships.projectId, project)));
    const granted = [...new Set([...(current?.actions ?? []), ...values.actions])];
    await tx
      .insert(memberships)
      .values({ userId: personId, projectId: project, actions: granted })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.projectId],
        set: { actions: granted },
      });
    let mailId: string | null = null;
    if (mail === "queued") {
      const [job] = await tx
        .insert(jobs)
        .values({
          projectId: project,
          type: "mail.test",
          dedupKey: `invite:${randomUUID()}`,
          payload: {
            userId: principal.id,
            to: email,
            connectionId,
            language,
            invitation: {
              name: existing?.name ?? values.name,
              inviter: inviter?.displayName ?? inviter?.name ?? "",
            },
          },
        })
        .returning({ id: jobs.id });
      mailId = job?.id ?? null;
    }
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "operator.invite",
      targetId: personId,
      detail: { email, actions: values.actions, created: !existing, mail },
    });
    return {
      id: personId,
      email,
      name: existing?.name ?? values.name,
      created: !existing,
      actions: granted,
      mail,
      mailId,
      canSignIn: Boolean(verified),
    };
  });
}
