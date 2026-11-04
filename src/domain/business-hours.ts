// Business hours of a project: the days of the week and the hours of the day in which the response clock runs, in
// the time zone of the project, and the holidays on which it does not. Without them the clock counts every hour, as
// it always did.
//
// The settings hold them as plain values (the configuration document is flat):
//   businessDays      "1,2,3,4,5" (ISO weekdays, 1 is Monday, 7 is Sunday), or null for no business hours
//   businessStart     "09:00"
//   businessEnd       "17:00", later than the start
//   businessTimeZone  an IANA name such as "Europe/Berlin"
//   holidays          "2026-12-25,2026-12-26" (dates in the time zone of the project)
export interface BusinessCalendar {
  timeZone: string;
  days: readonly number[];
  startMinute: number;
  endMinute: number;
  holidays: ReadonlySet<string>;
}
export const defaultBusinessStart = "09:00";
export const defaultBusinessEnd = "17:00";
export const maxHolidays = 200;
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
export const minuteOf = (value: string): number | null => {
  const found = timePattern.exec(value);
  return found ? Number(found[1]) * 60 + Number(found[2]) : null;
};
export const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.length > 0 && value.length <= 64;
  } catch {
    return false;
  }
};
// A real calendar date, not 2026-02-30.
export const isDate = (value: string): boolean => {
  const found = datePattern.exec(value);
  if (!found) return false;
  const moment = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])));
  return moment.toISOString().slice(0, 10) === value;
};
export const parseDays = (value: string): number[] | null => {
  const days = value.split(",").map((entry) => Number(entry.trim()));
  const valid =
    days.length > 0 &&
    days.length <= 7 &&
    days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) &&
    new Set(days).size === days.length;
  return valid ? [...days].sort((a, b) => a - b) : null;
};
export const parseHolidays = (value: string): string[] | null => {
  const dates = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const valid =
    dates.length <= maxHolidays && dates.every(isDate) && new Set(dates).size === dates.length;
  return valid ? [...dates].sort() : null;
};
// What the settings say, when they say it completely and validly; otherwise no business hours.
export function calendarOf(settings: Record<string, unknown>): BusinessCalendar | null {
  const { businessDays, businessTimeZone, businessStart, businessEnd, holidays } = settings;
  if (
    typeof businessDays !== "string" ||
    typeof businessTimeZone !== "string" ||
    !isTimeZone(businessTimeZone)
  )
    return null;
  const days = parseDays(businessDays);
  const startMinute = minuteOf(
    typeof businessStart === "string" ? businessStart : defaultBusinessStart,
  );
  const endMinute = minuteOf(typeof businessEnd === "string" ? businessEnd : defaultBusinessEnd);
  if (!days || startMinute === null || endMinute === null || startMinute >= endMinute) return null;
  const listed = typeof holidays === "string" ? (parseHolidays(holidays) ?? []) : [];
  return { timeZone: businessTimeZone, days, startMinute, endMinute, holidays: new Set(listed) };
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(instant: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  const found: Record<string, number> = {};
  for (const part of format.formatToParts(instant))
    if (part.type !== "literal") found[part.type] = Number(part.value);
  return found as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}
// How far the local time of the zone is ahead of UTC at an instant, in milliseconds.
function offsetAt(instant: number, timeZone: string): number {
  const local = parts(instant, timeZone);
  return (
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
    Math.floor(instant / 1000) * 1000
  );
}
// The instant at which the clock of the zone shows the given minute of the given day.
function instantOf(year: number, month: number, day: number, minute: number, timeZone: string) {
  const wall = Date.UTC(year, month - 1, day, 0, minute);
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  return second;
}
const dayMillis = 86_400_000;
const horizonDays = 3660;
// The time between two instants that lies within business hours, in milliseconds.
export function businessMillis(from: Date, to: Date, calendar: BusinessCalendar): number {
  const end = to.getTime();
  // Ten years of waiting are more than any limit; counting stops there.
  const start = Math.max(from.getTime(), end - horizonDays * dayMillis);
  if (end <= start) return 0;
  const first = parts(start, calendar.timeZone);
  const last = parts(end, calendar.timeZone);
  const lastDay = Date.UTC(last.year, last.month - 1, last.day);
  let total = 0;
  for (
    let day = Date.UTC(first.year, first.month - 1, first.day);
    day <= lastDay;
    day += dayMillis
  ) {
    const date = new Date(day);
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    if (!calendar.days.includes(weekday) || calendar.holidays.has(date.toISOString().slice(0, 10)))
      continue;
    const [year, month, number] = [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
    ];
    const opens = instantOf(year, month, number, calendar.startMinute, calendar.timeZone);
    const closes = instantOf(year, month, number, calendar.endMinute, calendar.timeZone);
    total += Math.max(0, Math.min(end, closes) - Math.max(start, opens));
  }
  return total;
}
// The time that counts for the clock: business time when the project has business hours, all time otherwise.
export function clockMillis(from: Date, to: Date, calendar: BusinessCalendar | null): number {
  return calendar ? businessMillis(from, to, calendar) : Math.max(0, to.getTime() - from.getTime());
}
// The five values of the configuration, as they are read from the settings: each one valid on its own, and the
// days switched off when the rest does not make business hours.
export function businessSettingsOf(settings: Record<string, unknown>) {
  const calendar = calendarOf(settings);
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const valid = (value: unknown, fallback: string) =>
    minuteOf(text(value)) === null ? fallback : text(value);
  const start = valid(settings.businessStart, defaultBusinessStart);
  const end = valid(settings.businessEnd, defaultBusinessEnd);
  const zone = text(settings.businessTimeZone);
  return {
    businessDays: calendar ? calendar.days.join(",") : null,
    businessStart: start,
    businessEnd: end,
    businessTimeZone: calendar ? calendar.timeZone : isTimeZone(zone) ? zone : null,
    holidays: (parseHolidays(text(settings.holidays)) ?? []).join(","),
  };
}
// What is stored for the five values: weekdays sorted and holidays sorted, one way of writing each.
export function businessValuesOf(config: {
  businessDays: string | null;
  businessStart: string;
  businessEnd: string;
  businessTimeZone: string | null;
  holidays: string;
}) {
  return {
    businessDays:
      config.businessDays === null ? null : (parseDays(config.businessDays) ?? []).join(","),
    businessStart: config.businessStart,
    businessEnd: config.businessEnd,
    businessTimeZone: config.businessTimeZone,
    holidays: (parseHolidays(config.holidays) ?? []).join(","),
  };
}
