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
    requesterEmail: text("requester_email").notNull(),
    requesterName: text("requester_name").notNull(),
    language: text("language").notNull().default("en"),
    channel: text("channel").notNull().default("email"),
    assigneeUserId: text("assignee_user_id").references(() => user.id),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    revision: integer("revision").notNull().default(1),
    pendingSince: timestamp("pending_since", { withTimezone: true }),
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
export const participants = pgTable(
  "participant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    verified: boolean("verified").notNull().default(false),
    portalTokenHash: text("portal_token_hash").unique(),
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
    status: text("status").notNull().default("draft"),
    lastErrorCode: text("last_error_code"),
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
    externalKey: text("external_key").notNull().unique(),
    rawObjectKey: text("raw_object_key").notNull(),
    checksum: text("checksum").notNull(),
    state: text("state").notNull().default("queued"),
    parsed: jsonb("parsed").$type<Record<string, unknown>>(),
    classification: jsonb("classification").$type<Record<string, unknown>>(),
    ticketId: uuid("ticket_id").references(() => tickets.id),
    receivedAt: created(),
  },
  (t) => [index("ingress_project_idx").on(t.projectId)],
);
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "retry",
  "succeeded",
  "review",
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
