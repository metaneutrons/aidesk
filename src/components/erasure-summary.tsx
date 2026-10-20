"use client";
import { useTranslations } from "next-intl";
import type { erasureCounts, outOfReach } from "../domain/erasure";
import type { z } from "zod";
// What an erasure removes and what it cannot reach, in words: the numbers that the person confirms.
const keys = [
  "tickets",
  "messages",
  "attachments",
  "originals",
  "translations",
  "issueLinks",
  "portalRecords",
  "runs",
  "jobs",
  "ingress",
] as const;
export function ErasureSummary({
  counts,
  reach,
}: {
  counts: z.infer<typeof erasureCounts>;
  reach: z.infer<typeof outOfReach>;
}) {
  const t = useTranslations();
  return (
    <div className="erasure-summary">
      <p>{t("eraseRemoves")}</p>
      <ul>
        {keys
          .filter((key) => counts[key] > 0)
          .map((key) => (
            <li key={key}>{t(`eraseCount_${key}`, { count: counts[key] })}</li>
          ))}
      </ul>
      <p>{t("eraseOutOfReach")}</p>
      <ul>
        <li>{t("eraseReach_webhookEvents", { count: reach.webhookEvents })}</li>
        <li>{t("eraseReach_issuesCreated", { count: reach.issuesCreated })}</li>
        <li>{t("eraseReach_exports", { count: reach.exports })}</li>
        <li>{t("eraseReach_providers")}</li>
        <li>{t("eraseReach_backups")}</li>
      </ul>
    </div>
  );
}
