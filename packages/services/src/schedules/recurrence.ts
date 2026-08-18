export type ScheduledRecurrence =
  { format: "once"; value: string } | { format: "rrule"; value: string };

export interface NextOccurrenceOptions {
  after?: Date;
  anchor?: Date;
  timezone?: string;
}

type Frequency = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

interface ParsedRule {
  frequency: Frequency;
  interval: number;
  byDay?: number[];
  byMonthDay?: number[];
  byHour?: number[];
  byMinute?: number[];
  until?: number;
}

const dayNumbers: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export function validateScheduledRecurrence(
  recurrence: ScheduledRecurrence,
): boolean {
  try {
    computeNextScheduledTime(recurrence, {
      after: new Date(0),
      anchor: new Date(0),
    });
    return true;
  } catch {
    return false;
  }
}

export function computeNextScheduledTime(
  recurrence: ScheduledRecurrence,
  options: NextOccurrenceOptions = {},
): number {
  const after = options.after ?? new Date();
  if (recurrence.format === "once") {
    const timestamp = Date.parse(recurrence.value);
    if (!Number.isFinite(timestamp))
      throw new Error(`Invalid one-time schedule: ${recurrence.value}`);
    if (timestamp <= after.getTime())
      throw new Error("One-time schedule is not in the future");
    return timestamp;
  }

  const rule = parseRRule(recurrence.value);
  assertTimezone(options.timezone);
  const anchor = options.anchor ?? after;
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const end = start + 366 * 5 * 24 * 60 * 60_000;
  for (let timestamp = start; timestamp <= end; timestamp += 60_000) {
    if (rule.until !== undefined && timestamp > rule.until) break;
    if (matchesRule(timestamp, anchor.getTime(), rule, options.timezone))
      return timestamp;
  }
  throw new Error("RRULE has no matching time in the next five years");
}

export function parseRRule(value: string): ParsedRule {
  const normalized = value.trim().replace(/^RRULE:/i, "");
  const entries = new Map(
    normalized
      .split(";")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) throw new Error(`Invalid RRULE entry: ${entry}`);
        return [
          entry.slice(0, separator).toUpperCase(),
          entry.slice(separator + 1).toUpperCase(),
        ];
      }),
  );
  const frequency = entries.get("FREQ") as Frequency | undefined;
  if (
    !frequency ||
    !["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY"].includes(frequency)
  ) {
    throw new Error(
      "RRULE FREQ must be MINUTELY, HOURLY, DAILY, WEEKLY, or MONTHLY",
    );
  }
  const interval = parsePositiveInteger(
    entries.get("INTERVAL") ?? "1",
    "INTERVAL",
  );
  const byDay = parseList(entries.get("BYDAY"), (item) => {
    const day = dayNumbers[item];
    if (day === undefined) throw new Error(`Invalid RRULE day: ${item}`);
    return day;
  });
  const byMonthDay = parseList(entries.get("BYMONTHDAY"), (item) => {
    const day = Number(item);
    if (!Number.isInteger(day) || day < 1 || day > 31)
      throw new Error(`Invalid BYMONTHDAY: ${item}`);
    return day;
  });
  const byHour = parseList(entries.get("BYHOUR"), (item) =>
    parseRange(item, "BYHOUR", 0, 23),
  );
  const byMinute = parseList(entries.get("BYMINUTE"), (item) =>
    parseRange(item, "BYMINUTE", 0, 59),
  );
  const untilValue = entries.get("UNTIL");
  const until = untilValue ? parseUntil(untilValue) : undefined;
  return {
    frequency,
    interval,
    ...(byDay?.length ? { byDay } : {}),
    ...(byMonthDay?.length ? { byMonthDay } : {}),
    ...(byHour?.length ? { byHour } : {}),
    ...(byMinute?.length ? { byMinute } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

function matchesRule(
  timestamp: number,
  anchor: number,
  rule: ParsedRule,
  timezone?: string,
): boolean {
  const candidate = wallClockParts(timestamp, timezone);
  const origin = wallClockParts(anchor, timezone);
  if (rule.byMinute && !rule.byMinute.includes(candidate.minute)) return false;
  if (rule.byHour && !rule.byHour.includes(candidate.hour)) return false;
  if (rule.byDay && !rule.byDay.includes(candidate.weekday)) return false;
  if (rule.byMonthDay && !rule.byMonthDay.includes(candidate.day)) return false;

  const elapsedMinutes = Math.floor((timestamp - anchor) / 60_000);
  if (elapsedMinutes < 0) return false;
  if (rule.frequency === "MINUTELY")
    return elapsedMinutes % rule.interval === 0;
  if (rule.frequency === "HOURLY") {
    return (
      candidate.minute === (rule.byMinute?.[0] ?? origin.minute) &&
      Math.floor(elapsedMinutes / 60) % rule.interval === 0
    );
  }

  const elapsedDays = calendarDayNumber(candidate) - calendarDayNumber(origin);
  if (rule.frequency === "DAILY") {
    return (
      elapsedDays >= 0 &&
      elapsedDays % rule.interval === 0 &&
      candidate.hour === (rule.byHour?.[0] ?? origin.hour) &&
      candidate.minute === (rule.byMinute?.[0] ?? origin.minute)
    );
  }
  if (rule.frequency === "WEEKLY") {
    const weeks = Math.floor((elapsedDays + origin.weekday) / 7);
    const days = rule.byDay ?? [origin.weekday];
    return (
      weeks >= 0 &&
      weeks % rule.interval === 0 &&
      days.includes(candidate.weekday) &&
      candidate.hour === (rule.byHour?.[0] ?? origin.hour) &&
      candidate.minute === (rule.byMinute?.[0] ?? origin.minute)
    );
  }
  const elapsedMonths =
    (candidate.year - origin.year) * 12 + candidate.month - origin.month;
  const monthDays = rule.byMonthDay ?? [origin.day];
  return (
    elapsedMonths >= 0 &&
    elapsedMonths % rule.interval === 0 &&
    monthDays.includes(candidate.day) &&
    candidate.hour === (rule.byHour?.[0] ?? origin.hour) &&
    candidate.minute === (rule.byMinute?.[0] ?? origin.minute)
  );
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClockParts(timestamp: number, timezone?: string): WallClockParts {
  if (!timezone) {
    const date = new Date(timestamp);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const values = Object.fromEntries(
    formatter.formatToParts(timestamp).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    weekday: dayNumbers[String(values.weekday).slice(0, 2).toUpperCase()]!,
  };
}

function calendarDayNumber(
  value: Pick<WallClockParts, "year" | "month" | "day">,
): number {
  return Math.floor(
    Date.UTC(value.year, value.month - 1, value.day) / 86_400_000,
  );
}

function parseList<T>(
  value: string | undefined,
  parse: (item: string) => T,
): T[] | undefined {
  return value ? value.split(",").map(parse) : undefined;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`Invalid ${field}: ${value}`);
  return parsed;
}

function parseRange(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

function parseUntil(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw new Error(`Invalid RRULE UNTIL: ${value}`);
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

function assertTimezone(timezone?: string): void {
  if (!timezone) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }
}
