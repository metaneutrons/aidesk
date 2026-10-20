"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { normalizePattern, senderRuleKinds } from "../domain/sender-rules";
// The lists of senders of a project: addresses and domains whose mail is always taken or always kept out.
const ruleSchema = z.object({
  id: z.string(),
  kind: z.enum(senderRuleKinds),
  type: z.enum(["address", "domain"]),
  value: z.string(),
  note: z.string().nullable(),
});
type Rule = z.infer<typeof ruleSchema>;
type Problem = "invalid" | "exists" | "full" | "error";
export function SenderRules({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations();
  const titleId = useId();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<Rule["kind"]>("block");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const load = useCallback(
    async (current: () => boolean = () => true) => {
      const response = await fetch(`/api/v1/projects/${projectId}/sender-rules`).catch(() => null);
      const parsed = response?.ok ? z.array(ruleSchema).safeParse(await response.json()) : null;
      if (parsed?.success && current()) setRules(parsed.data);
    },
    [projectId],
  );
  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);
  if (rules === null) return null;
  async function add() {
    if (!normalizePattern(value)) {
      setProblem("invalid");
      return;
    }
    const response = await fetch(`/api/v1/projects/${projectId}/sender-rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, value, ...(note.trim() ? { note } : {}) }),
    }).catch(() => null);
    if (response?.ok) {
      setProblem(null);
      setValue("");
      setNote("");
    } else
      setProblem(response?.status === 409 ? "exists" : response?.status === 400 ? "full" : "error");
    await load();
  }
  async function remove(rule: Rule) {
    const response = await fetch(`/api/v1/projects/${projectId}/sender-rules/${rule.id}/delete`, {
      method: "POST",
    }).catch(() => null);
    setProblem(response?.ok ? null : "error");
    await load();
  }
  const problemText = {
    invalid: "senderRulesInvalid",
    exists: "senderRulesExists",
    full: "senderRulesFull",
    error: "error",
  } as const;
  return (
    <section className="connections sender-rules" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("senderRulesTitle", { project: name })}</h3>
      <p className="muted">{t("senderRulesHint")}</p>
      {problem && (
        <p className="error" role="alert">
          {t(problemText[problem])}
        </p>
      )}
      {rules.length === 0 ? (
        <p className="muted">{t("senderRulesNone")}</p>
      ) : (
        <ul className="connection-list">
          {rules.map((rule) => (
            <li key={rule.id}>
              <span>
                <strong>{rule.value}</strong>{" "}
                <span className="muted">
                  {rule.kind === "allow" ? t("senderRulesAllow") : t("senderRulesBlock")}
                  {rule.note ? ` · ${rule.note}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="secondary"
                aria-label={t("senderRulesRemove", { value: rule.value })}
                onClick={() => {
                  void remove(rule);
                }}
              >
                {t("senderRulesRemoveShort")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="form-row"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label>
          {t("senderRulesValue")}
          <input
            value={value}
            maxLength={320}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </label>
        <label>
          {t("senderRulesKind")}
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value === "allow" ? "allow" : "block");
            }}
          >
            <option value="block">{t("senderRulesBlock")}</option>
            <option value="allow">{t("senderRulesAllow")}</option>
          </select>
        </label>
        <label>
          {t("senderRulesNote")}
          <input
            value={note}
            maxLength={200}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </label>
        <button type="submit">{t("senderRulesAdd")}</button>
      </form>
    </section>
  );
}
