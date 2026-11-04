import { z } from "zod";
// The retention of a project: how long it keeps what it holds. Every period is off (null) until the project sets it,
// and the screen suggests values and presets none. The periods are counted in days from the moment named for each
// kind, and a scheduled job removes what is due in steps (see `server/retention.ts`).
export const retentionKinds = [
  "tickets",
  "attachments",
  "originals",
  "translations",
  "aiRuns",
] as const;
export type RetentionKind = (typeof retentionKinds)[number];
export const maxRetentionDays = 3650;
// The configuration key of the period of a kind.
export const retentionKey = (kind: RetentionKind) =>
  `retention${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}Days` as const;
export const retentionKeys = retentionKinds.map(retentionKey);
export const retentionPeriod = z.number().int().min(1).max(maxRetentionDays).nullable();
// What the screen suggests; none of it is set for a project.
export const retentionSuggestions: Record<RetentionKind, number> = {
  tickets: 730,
  attachments: 365,
  originals: 365,
  translations: 180,
  aiRuns: 90,
};
export type RetentionPeriods = Record<RetentionKind, number | null>;
export const retentionOf = (settings: Record<string, unknown>): RetentionPeriods =>
  Object.fromEntries(
    retentionKinds.map((kind) => {
      const value = settings[retentionKey(kind)];
      return [
        kind,
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= maxRetentionDays
          ? value
          : null,
      ];
    }),
  ) as RetentionPeriods;
// A period that is set where there was none, or made shorter, removes more than before: it needs a person with the
// right to approve. Lengthening it, or switching it off, removes nothing more.
export function tightens(from: RetentionPeriods, to: RetentionPeriods): RetentionKind[] {
  return retentionKinds.filter((kind) => {
    const next = to[kind];
    const before = from[kind];
    return next !== null && (before === null || next < before);
  });
}
export const retentionCounts = z.object({
  tickets: z.number().int().min(0),
  attachments: z.number().int().min(0),
  originals: z.number().int().min(0),
  translations: z.number().int().min(0),
  aiRuns: z.number().int().min(0),
});
export type RetentionCounts = z.infer<typeof retentionCounts>;
// A dry run: the periods to try, each null for none, and what they would remove now.
export const retentionPreviewInput = z
  .object({
    tickets: retentionPeriod,
    attachments: retentionPeriod,
    originals: retentionPeriod,
    translations: retentionPeriod,
    aiRuns: retentionPeriod,
  })
  .strict();
export const retentionPreviewOut = z.object({
  periods: retentionPreviewInput,
  due: retentionCounts,
});
// How many of a kind one pass of the job removes for one project.
export const retentionStep = 200;
