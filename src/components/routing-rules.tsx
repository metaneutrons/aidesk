"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { priorities, priorityOf, type Priority } from "../domain/triage";
import { priorityKey } from "./triage";
// How a project routes a new ticket: the rules in the order in which they are tried, and a form to add or change one.
// A rule without conditions matches every ticket; put last, it is the default.
const ruleSchema = z.object({
  id: z.string(),
  position: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  conditions: z.object({
    senders: z.array(z.string()),
    languages: z.array(z.string()),
    subjectWords: z.array(z.string()),
  }),
  target: z
    .object({
      kind: z.enum(["user", "group", "agent"]),
      id: z.string(),
      name: z.string().nullable(),
    })
    .nullable(),
  priority: z.enum(priorities).nullable(),
  category: z.string().nullable(),
});
type Rule = z.infer<typeof ruleSchema>;
const targetsSchema = z.object({
  users: z.array(z.object({ id: z.string(), name: z.string() })),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  agents: z.array(z.object({ id: z.string(), name: z.string(), managed: z.boolean() })),
});
type Targets = z.infer<typeof targetsSchema>;
const languages = ["en", "de"] as const;
const words = (value: string) =>
  value
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
const addresses = (value: string) => value.split(/[\s,]+/).filter(Boolean);
interface Draft {
  name: string;
  senders: string;
  languages: string[];
  subjectWords: string;
  target: string;
  priority: string;
  category: string;
}
const empty: Draft = {
  name: "",
  senders: "",
  languages: [],
  subjectWords: "",
  target: "",
  priority: "",
  category: "",
};
const draftOf = (rule: Rule): Draft => ({
  name: rule.name,
  senders: rule.conditions.senders.join(", "),
  languages: rule.conditions.languages,
  subjectWords: rule.conditions.subjectWords.join(", "),
  target: rule.target ? `${rule.target.kind}:${rule.target.id}` : "",
  priority: rule.priority ?? "",
  category: rule.category ?? "",
});
export function RoutingRules({
  projectId,
  name,
  categories,
}: {
  projectId: string;
  name: string;
  categories: readonly string[];
}) {
  const t = useTranslations();
  const titleId = useId();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const base = `/api/v1/projects/${projectId}`;
  const load = useCallback(
    async (current: () => boolean = () => true) => {
      const [list, found] = await Promise.all([
        fetch(`${base}/routing-rules`).catch(() => null),
        fetch(`${base}/routing-targets`).catch(() => null),
      ]);
      const parsedRules = list?.ok ? z.array(ruleSchema).safeParse(await list.json()) : null;
      const parsedTargets = found?.ok ? targetsSchema.safeParse(await found.json()) : null;
      if (current() && parsedRules?.success && parsedTargets?.success) {
        setRules(parsedRules.data);
        setTargets(parsedTargets.data);
      }
    },
    [base],
  );
  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);
  if (rules === null || targets === null) return null;
  const body = () => {
    const [kind, ...rest] = draft.target.split(":");
    return {
      name: draft.name,
      conditions: {
        senders: addresses(draft.senders),
        languages: draft.languages,
        subjectWords: words(draft.subjectWords),
      },
      target: draft.target === "" ? null : { kind, id: rest.join(":") },
      priority: draft.priority === "" ? null : draft.priority,
      category: draft.category === "" ? null : draft.category,
      enabled:
        editing === null ? true : (rules.find((rule) => rule.id === editing)?.enabled ?? true),
    };
  };
  async function send(path: string, payload?: object) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }).catch(() => null);
    setFailed(!response?.ok);
    await load();
    return Boolean(response?.ok);
  }
  async function save() {
    const done = await send(
      editing === null ? "/routing-rules" : `/routing-rules/${editing}`,
      body(),
    );
    if (done) {
      setDraft(empty);
      setEditing(null);
    }
  }
  const move = (index: number, by: -1 | 1) => {
    const order = rules.map((rule) => rule.id);
    const other = order[index + by];
    const own = order[index];
    if (other === undefined || own === undefined) return;
    order[index + by] = own;
    order[index] = other;
    void send("/routing-order", { ids: order });
  };
  const describe = (rule: Rule) => {
    const conditions = [
      ...(rule.conditions.senders.length
        ? [`${t("routingSenders")}: ${rule.conditions.senders.join(", ")}`]
        : []),
      ...(rule.conditions.languages.length
        ? [`${t("routingLanguages")}: ${rule.conditions.languages.join(", ")}`]
        : []),
      ...(rule.conditions.subjectWords.length
        ? [`${t("routingSubject")}: ${rule.conditions.subjectWords.join(", ")}`]
        : []),
    ];
    const result = [
      ...(rule.target
        ? [`${t(`routingKind_${rule.target.kind}`)} ${rule.target.name ?? t("routingGone")}`]
        : []),
      ...(rule.priority ? [t(priorityKey(priorityOf(rule.priority)))] : []),
      ...(rule.category ? [rule.category] : []),
    ];
    return `${conditions.length ? conditions.join(" · ") : t("routingEveryTicket")} → ${result.join(" · ")}`;
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft({ ...draft, [key]: value });
  };
  return (
    <section className="connections routing-rules" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("routingTitle", { project: name })}</h3>
      <p className="muted">{t("routingHint")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("routingError")}
        </p>
      )}
      {rules.length === 0 ? (
        <p className="muted">{t("routingNone")}</p>
      ) : (
        <ol className="connection-list">
          {rules.map((rule, index) => (
            <li key={rule.id}>
              <span>
                <strong>{rule.name}</strong>{" "}
                {!rule.enabled && <span className="muted">({t("routingOff")}) </span>}
                <span className="muted">{describe(rule)}</span>
              </span>
              <span className="connection-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={index === 0}
                  aria-label={t("routingUp", { name: rule.name })}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  {t("routingUpShort")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={index === rules.length - 1}
                  aria-label={t("routingDown", { name: rule.name })}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  {t("routingDownShort")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={t("routingEdit", { name: rule.name })}
                  onClick={() => {
                    setEditing(rule.id);
                    setDraft(draftOf(rule));
                  }}
                >
                  {t("routingEditShort")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={t(rule.enabled ? "routingSwitchOff" : "routingSwitchOn", {
                    name: rule.name,
                  })}
                  onClick={() => {
                    void send(`/routing-rules/${rule.id}`, {
                      ...body2(rule),
                      enabled: !rule.enabled,
                    });
                  }}
                >
                  {t(rule.enabled ? "routingSwitchOffShort" : "routingSwitchOnShort")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={t("routingRemove", { name: rule.name })}
                  onClick={() => {
                    void send(`/routing-rules/${rule.id}/delete`);
                  }}
                >
                  {t("routingRemoveShort")}
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <form
        className="routing-form"
        aria-label={t(editing === null ? "routingAddForm" : "routingEditForm")}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          {t("routingName")}
          <input
            value={draft.name}
            maxLength={80}
            onChange={(event) => {
              set("name", event.target.value);
            }}
          />
        </label>
        <label>
          {t("routingSenders")}
          <input
            value={draft.senders}
            placeholder="example.org, kim@example.org"
            onChange={(event) => {
              set("senders", event.target.value);
            }}
          />
        </label>
        <fieldset>
          <legend>{t("routingLanguages")}</legend>
          {languages.map((entry) => (
            <label key={entry} className="check">
              <input
                type="checkbox"
                checked={draft.languages.includes(entry)}
                onChange={(event) => {
                  set(
                    "languages",
                    event.target.checked
                      ? [...draft.languages, entry]
                      : draft.languages.filter((other) => other !== entry),
                  );
                }}
              />
              {entry === "de" ? "Deutsch" : "English"}
            </label>
          ))}
        </fieldset>
        <label>
          {t("routingSubject")}
          <input
            value={draft.subjectWords}
            placeholder={t("routingSubjectHint")}
            onChange={(event) => {
              set("subjectWords", event.target.value);
            }}
          />
        </label>
        <label>
          {t("routingAssignTo")}
          <select
            value={draft.target}
            onChange={(event) => {
              set("target", event.target.value);
            }}
          >
            <option value="">{t("routingNobody")}</option>
            {targets.users.length > 0 && (
              <optgroup label={t("routingPeople")}>
                {targets.users.map((entry) => (
                  <option key={entry.id} value={`user:${entry.id}`}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            )}
            {targets.groups.length > 0 && (
              <optgroup label={t("routingGroups")}>
                {targets.groups.map((entry) => (
                  <option key={entry.id} value={`group:${entry.id}`}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            )}
            {targets.agents.length > 0 && (
              <optgroup label={t("routingAgents")}>
                {targets.agents.map((entry) => (
                  <option key={entry.id} value={`agent:${entry.id}`}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label>
          {t("priorityLabel")}
          <select
            value={draft.priority}
            onChange={(event) => {
              set("priority", event.target.value);
            }}
          >
            <option value="">{t("routingKeep")}</option>
            {priorities.map((entry: Priority) => (
              <option key={entry} value={entry}>
                {t(priorityKey(entry))}
              </option>
            ))}
          </select>
        </label>
        {categories.length > 0 && (
          <label>
            {t("categoryLabel")}
            <select
              value={draft.category}
              onChange={(event) => {
                set("category", event.target.value);
              }}
            >
              <option value="">{t("routingKeep")}</option>
              {categories.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="submit"
          disabled={
            draft.name.trim() === "" ||
            (draft.target === "" && draft.priority === "" && draft.category === "")
          }
        >
          {t(editing === null ? "routingAdd" : "routingSave")}
        </button>
        {editing !== null && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setEditing(null);
              setDraft(empty);
            }}
          >
            {t("routingCancel")}
          </button>
        )}
      </form>
    </section>
  );
}
// The body that stores a rule as it is.
const body2 = (rule: Rule) => ({
  name: rule.name,
  enabled: rule.enabled,
  conditions: rule.conditions,
  target: rule.target ? { kind: rule.target.kind, id: rule.target.id } : null,
  priority: rule.priority,
  category: rule.category,
});
