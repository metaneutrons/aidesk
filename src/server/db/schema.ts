import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Action } from "../../domain/permissions";
import { seal, unseal } from "../crypto";
import { env } from "../env";
const encryptedText = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => seal(value, env().ENCRYPTION_KEY),
  fromDriver: (value) => unseal(value, env().ENCRYPTION_KEY),
});
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: created(),
  updatedAt: updated(),
  active: boolean("active").notNull().default(true),
  owner: boolean("owner").notNull().default(false),
  locale: text("locale"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
});
export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: created(),
    updatedAt: updated(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("account_user_idx").on(t.userId),
    uniqueIndex("account_provider_idx").on(t.providerId, t.accountId),
  ],
);
export const verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
// Better Auth two-factor plugin. The secret and backup codes are encrypted by
// Better Auth itself with BETTER_AUTH_SECRET, so these are plain text columns.
export const twoFactor = pgTable(
  "auth_two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factor_user_idx").on(t.userId), index("two_factor_secret_idx").on(t.secret)],
);
export const ssoProvider = pgTable("sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: encryptedText("oidc_config"),
  samlConfig: encryptedText("saml_config"),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
  domainVerified: boolean("domain_verified").default(false),
});
export const projects = pgTable("project", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#5167ed"),
  defaultLanguage: text("default_language").notNull().default("en"),
  portalDomain: text("portal_domain"),
  portalDomainVerified: boolean("portal_domain_verified").notNull().default(false),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  // Raised by every applied configuration change; a writer names the version it
  // read, so a change made in between is never overwritten unseen.
  configVersion: integer("config_version").notNull().default(1),
  createdAt: created(),
  updatedAt: updated(),
});
export const memberships = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actions: jsonb("actions").$type<Action[]>().notNull().default([]),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("membership_user_project_idx").on(t.userId, t.projectId),
    index("membership_project_idx").on(t.projectId),
  ],
);
export const agents = pgTable(
  "agent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actions: jsonb("actions").$type<Action[]>().notNull().default([]),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    profileId: uuid("profile_id"),
    // The product runs this agent itself (a model works the tickets assigned to it); it
    // has no token that anyone knows, and its grants cap what the runner may do.
    managed: boolean("managed").notNull().default(false),
    createdAt: created(),
  },
  (t) => [index("agent_project_idx").on(t.projectId)],
);
export const ticketStatus = pgEnum("ticket_status", ["open", "waiting", "resolved"]);
export const tickets = pgTable(
  "ticket",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").generatedAlwaysAsIdentity().unique(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    subject: text("subject").notNull(),
    status: ticketStatus("status").notNull().default("open"),
    // A ticket in junk keeps its status and history but leaves the inbox
    // until a person restores it.
    junkAt: timestamp("junk_at", { withTimezone: true }),
    junkReason: text("junk_reason"),
    requesterEmail: text("requester_email").notNull(),
    requesterName: text("requester_name").notNull(),
    language: text("language").notNull().default("en"),
    channel: text("channel").notNull().default("email"),
    assigneeUserId: text("assignee_user_id").references(() => user.id),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    revision: integer("revision").notNull().default(1),
    // A person took the ticket over, or stopped the agent on it: no managed agent sends
    // for it until a person resumes it.
    agentPausedAt: timestamp("agent_paused_at", { withTimezone: true }),
    pendingSince: timestamp("pending_since", { withTimezone: true }),
    // When the team wants to look at the ticket again; private to the team.
    remindAt: timestamp("remind_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("ticket_project_idx").on(t.projectId),
    index("ticket_pending_idx").on(t.pendingSince),
  ],
);
export const messages = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email"),
    internal: boolean("internal").notNull().default(false),
    markdown: text("markdown").notNull(),
    language: text("language").notNull().default("en"),
    revision: integer("revision").notNull().default(1),
    rawObjectKey: text("raw_object_key"),
    receivedMessageId: text("received_message_id"),
    deliveryState: text("delivery_state").notNull().default("received"),
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index("message_ticket_idx").on(t.ticketId)],
);
// Files received with a message. Stored files are private and
// content-addressed; a refused file keeps only its metadata and the reason.
export const attachments = pgTable(
  "attachment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Order within the message as received.
    position: integer("position").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    checksum: text("checksum").notNull(),
    objectKey: text("object_key"),
    inline: boolean("inline").notNull().default(false),
    contentId: text("content_id"),
    refusal: text("refusal"),
    createdAt: created(),
  },
  (t) => [index("attachment_message_idx").on(t.messageId)],
);
// The text of a file, read once by the worker and kept with the file: a derived
// record, not the file itself. It follows the attachment (and so the message)
// when that is deleted. `failure` says why no text exists; the extractor version
// lets a better reader replace an older result.
export const attachmentTexts = pgTable("attachment_text", {
  attachmentId: uuid("attachment_id")
    .primaryKey()
    .references(() => attachments.id, { onDelete: "cascade" }),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  method: text("method"),
  text: text("text"),
  unit: text("unit"),
  units: integer("units").notNull().default(0),
  truncated: boolean("truncated").notNull().default(false),
  hidden: integer("hidden").notNull().default(0),
  failure: text("failure"),
  createdAt: created(),
});
// What a task of the product asks of a model, per project: which connection and
// model, the limits, and whether the task may run at all. Off by default; a
// profile that is on sends ticket content to the provider of its connection.
export const aiProfiles = pgTable(
  "ai_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    model: text("model").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    dailyTokenBudget: integer("daily_token_budget").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    // Raised by every change; a writer names the version it read.
    version: integer("version").notNull().default(1),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ai_profile_project_task_unique").on(t.projectId, t.task)],
);
// The tokens a task of a project has used on a day, and those held for calls that
// are running or whose outcome is not known. A run reserves its share before it
// calls the provider and settles it after, so concurrent runs cannot spend more
// than the daily budget of the profile.
export const aiBudgets = pgTable(
  "ai_budget",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    day: text("day").notNull(),
    charged: integer("charged").notNull().default(0),
  },
  (t) => [uniqueIndex("ai_budget_day_unique").on(t.projectId, t.task, t.day)],
);
// What each run of a task was, without what it was about: no prompt, no ticket
// content and no answer are kept.
export const aiRuns = pgTable(
  "ai_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    profileVersion: integer("profile_version"),
    connectionId: uuid("connection_id"),
    model: text("model"),
    // ok, or the code of the failure.
    outcome: text("outcome").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: created(),
  },
  (t) => [index("ai_run_project_idx").on(t.projectId, t.task)],
);
export const participants = pgTable(
  "participant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    verified: boolean("verified").notNull().default(false),
    // Raised to replace the earlier link; the link itself is derived, not stored.
    portalEpoch: integer("portal_epoch").notNull().default(0),
    grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("participant_ticket_email_idx").on(t.ticketId, t.email)],
);
export const connections = pgTable(
  "connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    direction: text("direction").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secretCiphertext: text("secret_ciphertext"),
    // draft (not tested), ready, degraded (the last test or poll failed) or disabled.
    status: text("status").notNull().default("draft"),
    lastErrorCode: text("last_error_code"),
    // Raised by every change; a writer names the version it read.
    version: integer("version").notNull().default(1),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("connection_project_idx").on(t.projectId)],
);
// Position of an inbound mailbox adapter. A changed UIDVALIDITY restarts
// reading; duplicate Message-IDs are recognised by the inbound core.
export const syncCursors = pgTable("sync_cursor", {
  connectionId: uuid("connection_id")
    .primaryKey()
    .references(() => connections.id, { onDelete: "cascade" }),
  mailbox: text("mailbox").notNull(),
  uidValidity: text("uid_validity").notNull(),
  lastUid: integer("last_uid").notNull().default(0),
  updatedAt: updated(),
});
export const ingress = pgTable(
  "ingress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    connectionId: uuid("connection_id").references(() => connections.id),
    externalKey: text("external_key").notNull(),
    rawObjectKey: text("raw_object_key").notNull(),
    checksum: text("checksum").notNull(),
    state: text("state").notNull().default("queued"),
    parsed: jsonb("parsed").$type<Record<string, unknown>>(),
    classification: jsonb("classification").$type<Record<string, unknown>>(),
    // Where the adapter found the message and where it is now, for example
    // IMAP mailbox, UIDVALIDITY and UID, and the state of a pending move.
    origin: jsonb("origin").$type<Record<string, unknown>>(),
    ticketId: uuid("ticket_id").references(() => tickets.id),
    receivedAt: created(),
  },
  (t) => [
    index("ingress_project_idx").on(t.projectId),
    // An adapter's key is only unique within the project it delivers to, so a
    // colliding key of another account or project can never swallow a mail.
    uniqueIndex("ingress_project_key_idx").on(t.projectId, t.externalKey),
  ],
);
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "retry",
  "succeeded",
  "review",
  // Taken back before it ran, because what it was for no longer holds.
  "cancelled",
]);
export const jobs = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type").notNull(),
    dedupKey: text("dedup_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    lastErrorCode: text("last_error_code"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("job_due_idx").on(t.status, t.runAfter)],
);
export const audit = pgTable(
  "audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").references(() => projects.id),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetId: text("target_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index("audit_project_idx").on(t.projectId)],
);
// Versioned email designs of a project. A version is never changed; a new
// one is added and then selected, so a mail that was sent can always name the
// design it was rendered with.
export const emailDesigns = pgTable(
  "email_design",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("email_design_version_idx").on(t.projectId, t.version)],
);
export const translations = pgTable(
  "translation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sourceRevision: integer("source_revision").notNull(),
    language: text("language").notNull(),
    markdown: text("markdown"),
    status: text("status").notNull().default("queued"),
    profileId: uuid("profile_id"),
    profileRevision: integer("profile_revision"),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [uniqueIndex("translation_revision_idx").on(t.messageId, t.sourceRevision, t.language)],
);
// A change to a project's configuration: applied at once, or proposed by an
// agent and waiting for a person with config.approve. The diff is what the
// change does to the configuration the writer read; it carries no secrets.
export const configChanges = pgTable(
  "config_change",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // "config" for the project configuration; "connection.create", "connection.update"
    // and "connection.disable" for connections, whose id is the target (none for create).
    kind: text("kind").notNull().default("config"),
    target: text("target"),
    // The version of the thing changed: the project's configuration or the connection.
    baseVersion: integer("base_version").notNull(),
    status: text("status").$type<"pending" | "applied" | "rejected" | "superseded">().notNull(),
    proposedBy: text("proposed_by").notNull(),
    proposerKind: text("proposer_kind").$type<"human" | "agent">().notNull(),
    idempotencyKey: uuid("idempotency_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    diff: jsonb("diff").$type<{ pointer: string; from: unknown; to: unknown }[]>().notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    appliedVersion: integer("applied_version"),
    createdAt: created(),
  },
  (t) => [
    index("config_change_project_idx").on(t.projectId, t.createdAt),
    uniqueIndex("config_change_key_idx").on(t.projectId, t.idempotencyKey),
  ],
);
// Wording that a project sets in place of the built-in text, per key and
// language. Every change is a new version; the latest version is in use, and a
// version without text returns to the built-in wording.
export const projectTexts = pgTable(
  "project_text",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    language: text("language").notNull(),
    version: integer("version").notNull(),
    text: text("text"),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("project_text_version_idx").on(t.projectId, t.key, t.language, t.version)],
);
// An HTTPS endpoint of a project that receives events as signed requests. The
// signing secret is stored sealed and is never returned.
export const webhooks = pgTable(
  "webhook",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: jsonb("events").$type<string[]>().notNull(),
    // Allows a plain or local endpoint on a development stack only.
    developmentOnly: boolean("development_only").notNull().default(false),
    secretCiphertext: text("secret_ciphertext").notNull(),
    // active or disabled
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("webhook_project_idx").on(t.projectId)],
);
// One row per attempt to deliver an event, for the log of a webhook. It holds
// the outcome, never the body of the event or of the answer.
export const webhookDeliveries = pgTable(
  "webhook_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    event: text("event").notNull(),
    attempt: integer("attempt").notNull(),
    // succeeded, retry (another attempt follows) or failed (no more attempts)
    outcome: text("outcome").notNull(),
    responseStatus: integer("response_status"),
    code: text("code"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: created(),
  },
  (t) => [index("webhook_delivery_idx").on(t.webhookId, t.createdAt)],
);
// One run of a managed agent on a ticket, for one customer revision. The job executes it;
// this row is what a person sees and what the worker checks again before it acts, so a
// cancelled run stops even while its job is running.
export const agentRuns = pgTable(
  "agent_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    // The revision of the ticket that the run answers.
    revision: integer("revision").notNull(),
    // The revision that the run expects the ticket to be at: its own note raises the revision
    // of the ticket, and any other change makes the run stale.
    currentRevision: integer("current_revision").notNull(),
    // assignment or message.
    trigger: text("trigger").notNull(),
    // queued, running, draft_ready, sent, resolved, noted, nothing_to_do, cancelled,
    // failed, needs_person.
    state: text("state").notNull().default("queued"),
    // Why a run was cancelled, or the code of a failure.
    reason: text("reason"),
    steps: integer("steps").notNull().default(0),
    replies: integer("replies").notNull().default(0),
    notes: integer("notes").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    index("agent_run_ticket_idx").on(t.ticketId, t.createdAt),
    uniqueIndex("agent_run_revision_idx").on(t.agentId, t.ticketId, t.revision),
  ],
);
