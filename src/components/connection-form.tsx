"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { Actions, Group, Row, Switch } from "./form";
// The form of a connection: the fields of each kind and its secret. A secret is typed here and is
// never shown again; on a change, a secret that is left empty stays as it is. The server checks
// every field and says which one is wrong.
type FieldType = "text" | "number" | "boolean" | "lines" | "pages" | "password";
interface Field {
  name: string;
  type: FieldType;
  optional?: boolean;
  fallback?: string | number | boolean;
  // A secret the product can make: a button fills the field with a random value and shows it once.
  generate?: boolean;
}
interface Definition {
  key: string;
  kind: string;
  direction: string;
  config: Field[];
  secret: Field[];
}
const text = (name: string, optional = false, fallback?: string): Field => ({
  name,
  type: "text",
  optional,
  ...(fallback === undefined ? {} : { fallback }),
});
const secret = (name: string, optional = false, generate = false): Field => ({
  name,
  type: "password",
  optional,
  ...(generate ? { generate } : {}),
});
export const definitions: Definition[] = [
  {
    key: "imap:inbound",
    kind: "imap",
    direction: "inbound",
    config: [
      text("host"),
      { name: "port", type: "number", fallback: 993 },
      { name: "secure", type: "boolean", fallback: true },
      text("user"),
      text("mailbox", true, "INBOX"),
      text("junkMailbox", true),
    ],
    secret: [secret("pass")],
  },
  {
    key: "cloudflare:inbound",
    kind: "cloudflare",
    direction: "inbound",
    config: [text("endpoint"), text("bucket"), text("address"), text("region", true, "auto")],
    secret: [secret("accessKeyId"), secret("secretAccessKey")],
  },
  {
    key: "push:inbound",
    kind: "push",
    direction: "inbound",
    config: [
      { name: "addresses", type: "lines" },
      { name: "allowedSources", type: "lines", optional: true },
    ],
    secret: [secret("token", false, true)],
  },
  {
    key: "smtp:inbound",
    kind: "smtp",
    direction: "inbound",
    config: [
      { name: "addresses", type: "lines" },
      { name: "allowedSources", type: "lines", optional: true },
      { name: "requireTls", type: "boolean", fallback: false },
    ],
    secret: [],
  },
  {
    key: "smtp:outbound",
    kind: "smtp",
    direction: "outbound",
    config: [
      text("host"),
      { name: "port", type: "number", fallback: 587 },
      { name: "secure", type: "boolean", fallback: false },
      text("from"),
      text("replyTo"),
    ],
    secret: [secret("user", true), secret("pass", true), secret("apiKey", true)],
  },
  {
    key: "cloudflare:outbound",
    kind: "cloudflare",
    direction: "outbound",
    config: [text("accountId"), text("from"), text("replyTo")],
    secret: [secret("apiToken")],
  },
  {
    key: "mailjet:outbound",
    kind: "mailjet",
    direction: "outbound",
    config: [text("from"), text("replyTo")],
    secret: [secret("apiKey"), secret("secretKey")],
  },
  {
    key: "anthropic:ai",
    kind: "anthropic",
    direction: "ai",
    config: [text("endpoint", true), text("workspaceId", true)],
    secret: [secret("apiKey")],
  },
  {
    key: "openai:ai",
    kind: "openai",
    direction: "ai",
    config: [text("endpoint", true)],
    secret: [secret("apiKey")],
  },
  {
    key: "google:ai",
    kind: "google",
    direction: "ai",
    config: [text("endpoint", true)],
    secret: [secret("apiKey")],
  },
  {
    key: "github:knowledge",
    kind: "github",
    direction: "knowledge",
    config: [{ name: "repositories", type: "lines" }, text("endpoint", true)],
    secret: [secret("token")],
  },
  {
    key: "docs:knowledge",
    kind: "docs",
    direction: "knowledge",
    config: [{ name: "pages", type: "pages" }],
    secret: [secret("token", true)],
  },
  {
    key: "context:knowledge",
    kind: "context",
    direction: "knowledge",
    config: [text("endpoint")],
    secret: [secret("apiKey")],
  },
];
// Text fields hold strings, whatever the stored value is.
export function toValues(
  definition: Definition,
  config: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of definition.config) {
    const stored = config[field.name];
    if (field.type === "boolean")
      values[field.name] = String(typeof stored === "boolean" ? stored : (field.fallback ?? false));
    else if (field.type === "lines")
      values[field.name] = Array.isArray(stored) ? stored.map(String).join("\n") : "";
    else if (field.type === "pages")
      values[field.name] = Array.isArray(stored)
        ? stored
            .map(
              (page: { title?: unknown; url?: unknown }) =>
                `${String(page.title)} | ${String(page.url)}`,
            )
            .join("\n")
        : "";
    else
      values[field.name] =
        typeof stored === "string" || typeof stored === "number"
          ? String(stored)
          : String(field.fallback ?? "");
  }
  return values;
}
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
export function toConfig(
  definition: Definition,
  values: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of definition.config) {
    const value = values[field.name] ?? "";
    if (field.type === "boolean") config[field.name] = value === "true";
    else if (field.type === "number") config[field.name] = Number(value);
    else if (field.type === "lines") config[field.name] = lines(value);
    else if (field.type === "pages")
      config[field.name] = lines(value).map((line) => {
        const cut = line.indexOf("|");
        return cut < 0
          ? { title: line, url: line }
          : { title: line.slice(0, cut).trim(), url: line.slice(cut + 1).trim() };
      });
    else if (value.trim() !== "" || !field.optional) config[field.name] = value.trim();
  }
  return config;
}
const issues = z.object({
  issues: z.array(z.object({ pointer: z.string(), message: z.string() })).optional(),
});
export function ConnectionForm({
  projectId,
  existing,
  onDone,
  onCancel,
}: {
  projectId: string;
  existing?: {
    id: string;
    kind: string;
    direction: string;
    name: string;
    version: number;
    config: Record<string, unknown>;
    secretSet: boolean;
  };
  onDone: (proposed: boolean) => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const id = useId();
  const initial =
    definitions.find(
      (entry) => entry.kind === existing?.kind && entry.direction === existing.direction,
    ) ?? definitions[0];
  const [key, setKey] = useState(initial?.key ?? "");
  const definition = definitions.find((entry) => entry.key === key) ?? definitions[0];
  const [name, setName] = useState(existing?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(
    definition ? toValues(definition, existing?.config ?? {}) : {},
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // The secrets that the product made and that are shown in plain text, so that they can be copied.
  const [revealed, setRevealed] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [failed, setFailed] = useState<"error" | "stale" | null>(null);
  const [working, setWorking] = useState(false);
  if (!definition) return null;
  const choose = (next: string) => {
    const target = definitions.find((entry) => entry.key === next);
    setKey(next);
    if (target) setValues(toValues(target, {}));
    setSecrets({});
    setRevealed([]);
  };
  async function submit(): Promise<void> {
    if (!definition) return;
    setWorking(true);
    setFailed(null);
    setProblems([]);
    const filled = Object.fromEntries(
      definition.secret.flatMap((field) => {
        const value = secrets[field.name] ?? "";
        return value === "" ? [] : [[field.name, value]];
      }),
    );
    const config = toConfig(definition, values);
    const response = await fetch(
      existing
        ? `/api/v1/projects/${projectId}/connections/${existing.id}`
        : `/api/v1/projects/${projectId}/connections`,
      {
        method: existing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          existing
            ? {
                expectedVersion: existing.version,
                name,
                config,
                ...(Object.keys(filled).length > 0 ? { secret: filled } : {}),
              }
            : {
                kind: definition.kind,
                direction: definition.direction,
                name,
                config,
                ...(Object.keys(filled).length > 0 ? { secret: filled } : {}),
              },
        ),
      },
    ).catch(() => null);
    setWorking(false);
    if (response?.ok) {
      onDone(response.status === 202);
      return;
    }
    const body = issues.safeParse(await response?.json().catch(() => null));
    if (body.success && body.data.issues?.length)
      setProblems(body.data.issues.map((issue) => `${issue.pointer}: ${issue.message}`));
    setFailed(response?.status === 409 ? "stale" : "error");
  }
  const label = (field: Field, secretField: boolean) =>
    `${t(secretField ? `connSecret_${field.name}` : `connField_${field.name}`)}${field.optional ? ` ${t("connOptional")}` : ""}`;
  return (
    <form
      className="connection-form stack"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Group>
        {!existing && (
          <Row label={t("connType")}>
            {(props) => (
              <select
                {...props}
                value={key}
                onChange={(event) => {
                  choose(event.target.value);
                }}
              >
                {definitions.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {t(`connectionKind_${entry.kind}`)} · {t(`connection_${entry.direction}`)}
                  </option>
                ))}
              </select>
            )}
          </Row>
        )}
        <Row label={t("connName")}>
          {(props) => (
            <input
              {...props}
              required
              maxLength={100}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Row>
        {definition.config.map((field) =>
          field.type === "boolean" ? (
            <Switch
              key={field.name}
              label={label(field, false)}
              checked={values[field.name] === "true"}
              onChange={(checked) => {
                setValues({ ...values, [field.name]: String(checked) });
              }}
            />
          ) : field.type === "lines" || field.type === "pages" ? (
            <Row
              key={field.name}
              label={label(field, false)}
              hint={t(`connHint_${field.name}`)}
              stacked
            >
              {(props) => (
                <textarea
                  {...props}
                  rows={4}
                  value={values[field.name] ?? ""}
                  onChange={(event) => {
                    setValues({ ...values, [field.name]: event.target.value });
                  }}
                />
              )}
            </Row>
          ) : (
            <Row key={field.name} label={label(field, false)}>
              {(props) => (
                <input
                  {...props}
                  type={field.type === "number" ? "number" : "text"}
                  value={values[field.name] ?? ""}
                  onChange={(event) => {
                    setValues({ ...values, [field.name]: event.target.value });
                  }}
                />
              )}
            </Row>
          ),
        )}
      </Group>
      {definition.secret.length > 0 && (
        <Group note={t("connSecretNote")}>
          {definition.secret.map((field) => (
            <Row key={`${id}:${field.name}`} label={label(field, true)}>
              {(props) => (
                <>
                  <input
                    {...props}
                    type={revealed.includes(field.name) ? "text" : "password"}
                    autoComplete="off"
                    value={secrets[field.name] ?? ""}
                    placeholder={existing?.secretSet ? t("connSecretKept") : ""}
                    onChange={(event) => {
                      setSecrets({ ...secrets, [field.name]: event.target.value });
                    }}
                  />
                  {field.generate && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        const bytes = crypto.getRandomValues(new Uint8Array(32));
                        const token = Array.from(bytes, (byte) =>
                          byte.toString(16).padStart(2, "0"),
                        ).join("");
                        setSecrets({ ...secrets, [field.name]: token });
                        setRevealed([...revealed, field.name]);
                      }}
                    >
                      {t("connSecretGenerate")}
                    </button>
                  )}
                  {revealed.includes(field.name) && (
                    <span role="status">{t("connSecretGenerated")}</span>
                  )}
                </>
              )}
            </Row>
          ))}
        </Group>
      )}
      {failed && (
        <div className="error" role="alert">
          {t(failed === "stale" ? "connStale" : "connError")}
          {problems.length > 0 && (
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Actions>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("connCancel")}
        </button>
        <button type="submit" className="primary" disabled={working || !name.trim()}>
          {t(existing ? "connSave" : "connCreate")}
        </button>
      </Actions>
    </form>
  );
}
