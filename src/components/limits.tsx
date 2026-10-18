"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { limitBounds, limitDefaults, limitKeys, type LimitKey } from "../domain/limits";
// The limits of the whole installation, for an owner: files at intake and in the portal, how long a
// session and a link to the customer page last. A change applies to what comes after it; the page says so
// next to the fields where it matters.
const limitsSchema = z.object({
  intakeFiles: z.number(),
  intakeFileMiB: z.number(),
  portalFiles: z.number(),
  portalTotalMiB: z.number(),
  sessionHours: z.number(),
  portalLinkDays: z.number(),
});
type Values = Record<LimitKey, number>;
const label = (key: LimitKey) => `limit_${key}` as const;
export function Limits() {
  const t = useTranslations();
  const router = useRouter();
  const titleId = useId();
  const [stored, setStored] = useState<Values | null>(null);
  const [draft, setDraft] = useState<Partial<Record<LimitKey, string>>>({});
  const [message, setMessage] = useState<"saved" | "error" | null>(null);
  const load = useCallback(async (current: () => boolean = () => true) => {
    const response = await fetch("/api/v1/workspace/limits").catch(() => null);
    const parsed = response?.ok ? limitsSchema.safeParse(await response.json()) : null;
    if (parsed?.success && current()) {
      setStored(parsed.data);
      setDraft({});
    }
  }, []);
  // In development React runs the effect twice, and the answer of the first run arrives after a person has begun to
  // type; it is dropped, so that it does not take away what was typed.
  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);
  if (stored === null) return null;
  const shown = (key: LimitKey) => draft[key] ?? String(stored[key]);
  const parsed = (key: LimitKey): number | null => {
    const value = Number(shown(key));
    const [low, high] = limitBounds[key];
    return shown(key).trim() !== "" && Number.isInteger(value) && value >= low && value <= high
      ? value
      : null;
  };
  const changed = limitKeys.filter((key) => parsed(key) !== null && parsed(key) !== stored[key]);
  const invalid = limitKeys.some((key) => parsed(key) === null);
  async function save(values: Partial<Values>) {
    setMessage(null);
    const response = await fetch("/api/v1/workspace/limits", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    }).catch(() => null);
    setMessage(response?.ok ? "saved" : "error");
    await load();
    router.refresh();
  }
  return (
    <section className="connections limits" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("limitsTitle")}</h3>
      <p className="muted">{t("limitsHint")}</p>
      <form
        className="limits-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save(Object.fromEntries(changed.map((key) => [key, parsed(key)])));
        }}
      >
        {limitKeys.map((key) => (
          <label key={key}>
            <span>{t(label(key))}</span>
            <input
              type="number"
              inputMode="numeric"
              min={limitBounds[key][0]}
              max={limitBounds[key][1]}
              step={1}
              value={shown(key)}
              aria-invalid={parsed(key) === null}
              aria-describedby={`${titleId}-${key}`}
              onChange={(event) => {
                setDraft({ ...draft, [key]: event.target.value });
              }}
            />
            <small id={`${titleId}-${key}`} className="muted">
              {t("limitRange", {
                low: limitBounds[key][0],
                high: limitBounds[key][1],
                standard: limitDefaults[key],
              })}{" "}
              {t(`limit_${key}_note`)}
            </small>
          </label>
        ))}
        <span className="configuration-actions">
          <button type="submit" className="primary" disabled={changed.length === 0 || invalid}>
            {t("limitsSave")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void save(limitDefaults);
            }}
          >
            {t("limitsStandard")}
          </button>
        </span>
      </form>
      {message && (
        <p className={message === "error" ? "error" : "muted"} role="status">
          {t(message === "error" ? "limitsError" : "limitsSaved")}
        </p>
      )}
    </section>
  );
}
