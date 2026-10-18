"use client";
import { useCallback, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The usage of one project: the calls of the AI by task and day, the mail by day and what is stored. It is read when
// the block is opened, and again when the number of days is changed.
const usageSchema = z.object({
  days: z.number(),
  ai: z.array(
    z.object({
      day: z.string(),
      task: z.string(),
      calls: z.number(),
      outcomes: z.record(z.string(), z.number()),
      inputTokens: z.number(),
      outputTokens: z.number(),
      charged: z.number(),
      budget: z.number().nullable(),
      left: z.number().nullable(),
    }),
  ),
  mail: z.array(z.object({ day: z.string(), received: z.number(), sent: z.number() })),
  storage: z.object({ files: z.number(), bytes: z.number(), rawMails: z.number() }),
});
type Usage = z.infer<typeof usageSchema>;
const choices = [7, 14, 30, 90];
export function UsagePanel({
  projectId,
  name,
  locale,
}: {
  projectId: string;
  name: string;
  locale: string;
}) {
  const t = useTranslations();
  const titleId = useId();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [days, setDays] = useState(14);
  const [failed, setFailed] = useState(false);
  const number = new Intl.NumberFormat(locale);
  const load = useCallback(
    async (count: number) => {
      setFailed(false);
      const response = await fetch(
        `/api/v1/projects/${projectId}/usage?days=${String(count)}`,
      ).catch(() => null);
      const parsed = response?.ok ? usageSchema.safeParse(await response.json()) : null;
      if (parsed?.success) setUsage(parsed.data);
      else setFailed(true);
    },
    [projectId],
  );
  return (
    <section className="connections usage" aria-labelledby={`${titleId}-title`}>
      <details
        onToggle={(event) => {
          if (event.currentTarget.open && usage === null) void load(days);
        }}
      >
        <summary>
          <h3 id={`${titleId}-title`}>{t("usageTitle", { project: name })}</h3>
        </summary>
        <p className="muted">{t("usageHint")}</p>
        <label className="usage-days">
          <span>{t("usageDays")}</span>
          <select
            value={days}
            onChange={(event) => {
              const next = Number(event.target.value);
              setDays(next);
              void load(next);
            }}
          >
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {t("usageLastDays", { days: choice })}
              </option>
            ))}
          </select>
        </label>
        {failed && (
          <p className="error" role="alert">
            {t("usageError")}
          </p>
        )}
        {usage && (
          <>
            <h4>{t("usageAi")}</h4>
            {usage.ai.length === 0 ? (
              <p className="muted">{t("usageAiNone")}</p>
            ) : (
              <div className="table-scroll" role="region" aria-label={t("usageAi")} tabIndex={0}>
                <table className="settings-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("usageDay")}</th>
                      <th scope="col">{t("usageTask")}</th>
                      <th scope="col">{t("usageCalls")}</th>
                      <th scope="col">{t("usageOutcomes")}</th>
                      <th scope="col">{t("usageTokens")}</th>
                      <th scope="col">{t("usageBudget")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.ai.map((row) => (
                      <tr key={`${row.day}|${row.task}`}>
                        <td>{row.day}</td>
                        <td>
                          <code>{row.task}</code>
                        </td>
                        <td>{number.format(row.calls)}</td>
                        <td>
                          {Object.entries(row.outcomes)
                            .map(([outcome, calls]) => `${outcome}: ${String(calls)}`)
                            .join(", ")}
                        </td>
                        <td>
                          {t("usageTokenPair", {
                            input: number.format(row.inputTokens),
                            output: number.format(row.outputTokens),
                          })}
                        </td>
                        <td>
                          {row.budget === null
                            ? t("usageChargedOnly", { charged: number.format(row.charged) })
                            : t("usageBudgetLeft", {
                                charged: number.format(row.charged),
                                budget: number.format(row.budget),
                                left: number.format(row.left ?? 0),
                              })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h4>{t("usageMail")}</h4>
            {usage.mail.length === 0 ? (
              <p className="muted">{t("usageMailNone")}</p>
            ) : (
              <div className="table-scroll" role="region" aria-label={t("usageMail")} tabIndex={0}>
                <table className="settings-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("usageDay")}</th>
                      <th scope="col">{t("usageReceived")}</th>
                      <th scope="col">{t("usageSent")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.mail.map((row) => (
                      <tr key={row.day}>
                        <td>{row.day}</td>
                        <td>{number.format(row.received)}</td>
                        <td>{number.format(row.sent)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h4>{t("usageStorage")}</h4>
            <p>
              {t("usageStored", {
                files: number.format(usage.storage.files),
                size: number.format(Math.round((usage.storage.bytes / 1024 / 1024) * 10) / 10),
                mails: number.format(usage.storage.rawMails),
              })}
            </p>
          </>
        )}
      </details>
    </section>
  );
}
