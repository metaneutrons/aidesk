import { clockMillis, type BusinessCalendar } from "./business-hours";
import { priorities, priorityOf, type Priority } from "./triage";
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
// The configuration key of a limit of a priority: `warnHoursHigh`. The normal priority has the limits of the project.
export const priorityLimitKey = (kind: "warn" | "overdue", priority: Priority) =>
  `${kind}Hours${priority[0]?.toUpperCase() ?? ""}${priority.slice(1)}`;
const own = (settings: Record<string, unknown>, kind: "warn" | "overdue", priority: Priority) =>
  priority === "normal" ? undefined : settings[priorityLimitKey(kind, priority)];
// The limits of a project for a ticket of a priority, from its settings: the values of the priority when it has
// them and they are valid, those of the project otherwise, the defaults when neither is, and a warning never
// later than the overdue limit.
export function limitsOf(
  settings: Record<string, unknown>,
  priority: Priority = "normal",
): {
  warnHours: number;
  overdueHours: number;
} {
  const baseOverdue = hours(settings.overdueHours, defaultOverdueHours);
  const overdueHours = hours(own(settings, "overdue", priority), baseOverdue);
  const baseWarn = hours(settings.warnHours, defaultWarnHours);
  return {
    warnHours: Math.min(hours(own(settings, "warn", priority), baseWarn), overdueHours),
    overdueHours,
  };
}
// The limits of all four priorities, for the desk.
export function priorityLimitsOf(settings: Record<string, unknown>) {
  return Object.fromEntries(
    priorities.map((priority) => [priority, limitsOf(settings, priorityOf(priority))]),
  ) as Record<Priority, { warnHours: number; overdueHours: number }>;
}
