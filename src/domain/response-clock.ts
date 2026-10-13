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
