export interface ResponseCycle {
  receivedAt: Date;
  answeredAt: Date | null;
}
export function responseAge(cycle: ResponseCycle, now: Date): number | null {
  return cycle.answeredAt === null ? Math.max(0, now.getTime() - cycle.receivedAt.getTime()) : null;
}
export const defaultWarnHours = 4;
export const defaultOverdueHours = 24;
export function responseState(
  cycle: ResponseCycle,
  now: Date,
  warnHours = defaultWarnHours,
  overdueHours = defaultOverdueHours,
): "answered" | "pending" | "warning" | "overdue" {
  const age = responseAge(cycle, now);
  if (age === null) return "answered";
  if (age >= overdueHours * 3_600_000) return "overdue";
  return age >= warnHours * 3_600_000 ? "warning" : "pending";
}
const hours = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 720
    ? value
    : fallback;
// The limits of a project, from its settings: its own values when they are valid, the defaults
// otherwise, and a warning never later than the overdue limit.
export function limitsOf(settings: Record<string, unknown>): {
  warnHours: number;
  overdueHours: number;
} {
  const overdueHours = hours(settings.overdueHours, defaultOverdueHours);
  return {
    warnHours: Math.min(hours(settings.warnHours, defaultWarnHours), overdueHours),
    overdueHours,
  };
}
