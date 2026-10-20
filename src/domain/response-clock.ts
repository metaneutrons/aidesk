import { clockMillis, type BusinessCalendar } from "./business-hours";
export interface ResponseCycle {
  receivedAt: Date;
  answeredAt: Date | null;
}
// How long the customer has waited, counted in business time when the project has business hours.
export function responseAge(
  cycle: ResponseCycle,
  now: Date,
  calendar: BusinessCalendar | null = null,
): number | null {
  return cycle.answeredAt === null ? clockMillis(cycle.receivedAt, now, calendar) : null;
}
export const defaultWarnHours = 4;
export const defaultOverdueHours = 24;
export function responseState(
  cycle: ResponseCycle,
  now: Date,
  warnHours = defaultWarnHours,
  overdueHours = defaultOverdueHours,
  calendar: BusinessCalendar | null = null,
): "answered" | "pending" | "warning" | "overdue" {
  const age = responseAge(cycle, now, calendar);
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
