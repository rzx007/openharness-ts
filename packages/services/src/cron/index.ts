import type { Settings } from "@openharness/core";
import { createShellProcess } from "@openharness/sandbox";

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_MAX_CHARS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface CronJob {
  id: string;
  name: string;
  expression: string;
  command: string;
  cwd?: string;
  /** IANA timezone name, e.g. "Asia/Shanghai". Defaults to system local time. */
  timezone?: string;
  enabled: boolean;
  running: boolean;
  handler?: () => void | Promise<void>;
  lastRun?: number;
  nextRun?: number;
  createdAt?: number;
}

export type HistoryEntry = {
  name: string;
  timestamp: number;
  success: boolean;
  output?: string;
};

export interface CronTriggerOptions {
  cwd?: string;
  sessionId?: string;
  settings?: Settings;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CronTriggerResult extends HistoryEntry {
  interrupted?: boolean;
}

export type CronExecutionCause = "scheduled" | "manual";
export type CronExecutor = (
  job: CronJob,
  cause: CronExecutionCause,
  options: CronTriggerOptions,
) => Promise<CronTriggerResult>;

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private history: HistoryEntry[] = [];

  constructor(private readonly executor: CronExecutor = executeCronJob) {}

  register(
    id: string,
    expression: string,
    handler: () => void | Promise<void>,
  ): CronJob {
    const job: CronJob = {
      id,
      name: id,
      expression,
      command: "",
      enabled: true,
      running: false,
      handler,
      createdAt: Date.now(),
    };
    this.jobs.set(id, job);
    return job;
  }

  upsertJob(jobData: {
    id?: string;
    name: string;
    expression: string;
    command: string;
    cwd?: string;
    timezone?: string;
    enabled?: boolean;
  }): CronJob {
    const existing = this.findByName(jobData.name);
    const id = existing?.id ?? jobData.id ?? `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const job: CronJob = {
      id,
      name: jobData.name,
      expression: jobData.expression,
      command: jobData.command,
      cwd: jobData.cwd,
      timezone: jobData.timezone,
      enabled: jobData.enabled ?? true,
      running: false,
      handler: existing?.handler,
      lastRun: existing?.lastRun,
      nextRun: computeNextRunTime(jobData.expression, undefined, jobData.timezone),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    this.jobs.set(id, job);
    if (existing && this.timers.has(id)) {
      this.stop(id);
      if (job.enabled) this.start(id);
    }
    return job;
  }

  findByName(name: string): CronJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.name === name) return job;
    }
    return undefined;
  }

  start(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (!job.enabled) return false;
    if (job.running) return true;
    job.running = true;

    const scheduleNext = () => {
      if (!job.running) return;
      const target = computeNextRunTime(job.expression, undefined, job.timezone);
      job.nextRun = target;
      const delay = Math.max(0, target - Date.now());
      const timer = setTimeout(async () => {
        this.timers.delete(id);
        if (!job.running) return;
        if (Date.now() < target) {
          scheduleNext();
          return;
        }
        try {
          await this.executeJob(job, "scheduled");
        } finally {
          if (job.running) scheduleNext();
        }
      }, Math.min(delay, MAX_TIMER_DELAY_MS));
      this.timers.set(id, timer);
    };

    scheduleNext();
    return true;
  }

  /** Execute a configured job immediately through the same sandbox-aware path as scheduled runs. */
  async trigger(name: string, options: CronTriggerOptions = {}): Promise<CronTriggerResult> {
    const job = this.findByName(name);
    if (!job) throw new Error(`Cron job not found: ${name}`);
    return this.executeJob(job, "manual", options);
  }

  stop(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const job = this.jobs.get(id);
    if (job) job.running = false;
    return true;
  }

  stopAll(): void {
    for (const id of [...this.timers.keys()]) {
      this.stop(id);
    }
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): CronJob[] {
    return [...this.jobs.values()];
  }

  removeJob(id: string): boolean {
    this.stop(id);
    return this.jobs.delete(id);
  }

  setEnabled(name: string, enabled: boolean): CronJob | undefined {
    const job = this.findByName(name);
    if (!job) return undefined;
    job.enabled = enabled;
    if (!enabled && job.running) {
      this.stop(job.id);
    }
    return job;
  }

  deleteByName(name: string): boolean {
    const job = this.findByName(name);
    if (!job) return false;
    return this.removeJob(job.id);
  }

  getHistory(limit = 50): HistoryEntry[] {
    return this.history.slice(-limit);
  }

  clearHistory(): void {
    this.history = [];
  }

  private async executeJob(
    job: CronJob,
    cause: CronExecutionCause,
    options: CronTriggerOptions = {},
  ): Promise<CronTriggerResult> {
    const entry = await this.executor(job, cause, options);
    if (entry.success) job.lastRun = entry.timestamp;
    this.history.push(entry);
    job.nextRun = computeNextRunTime(job.expression, undefined, job.timezone);
    return entry;
  }
}

export async function executeCronJob(
  job: CronJob,
  _cause: CronExecutionCause,
  options: CronTriggerOptions = {},
): Promise<CronTriggerResult> {
  let output: string | undefined;
  let success = true;
  let interrupted = false;
  try {
    if (job.command) {
      const result = await runSandboxedCommand(job.command, {
        cwd: job.cwd ?? options.cwd ?? process.cwd(),
        sessionId: options.sessionId,
        settings: options.settings,
        timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        signal: options.signal,
      });
      interrupted = result.interrupted;
      success = result.exitCode === 0 && !result.timedOut && !interrupted;
      output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim().slice(0, OUTPUT_MAX_CHARS) || undefined;
      if (result.timedOut) {
        output = `Command timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms${output ? `\n${output}` : ""}`;
      } else if (interrupted) {
        output = `Command was stopped${output ? `\n${output}` : ""}`;
      }
    } else {
      await (job.handler ?? (() => {}))();
    }
  } catch (error) {
    success = false;
    interrupted = options.signal?.aborted ?? false;
    output = (error instanceof Error ? error.message : String(error)).slice(0, OUTPUT_MAX_CHARS);
  }
  return {
    name: job.name,
    timestamp: Date.now(),
    success,
    ...(output ? { output } : {}),
    ...(interrupted ? { interrupted: true } : {}),
  };
}

async function runSandboxedCommand(
  command: string,
  options: Required<Pick<CronTriggerOptions, "cwd" | "timeoutMs">> &
    Pick<CronTriggerOptions, "sessionId" | "settings" | "signal">,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; interrupted: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  try {
    const child = await createShellProcess(command, {
      cwd: options.cwd,
      sessionId: options.sessionId,
      settings: options.settings,
      signal: controller.signal,
      hostShell: "system",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const append = (current: string, chunk: Buffer): string =>
        (current + chunk.toString()).slice(0, OUTPUT_MAX_CHARS);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (controller.signal.aborted) {
          resolve({ exitCode: 1, stdout, stderr, timedOut, interrupted: !timedOut });
        } else {
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          timedOut,
          interrupted: controller.signal.aborted && !timedOut,
        });
      });
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function validateCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return parts.every((part, index) => parseField(part, ...ranges[index]!).size > 0);
}

interface WallClockFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

function getTimezoneFields(
  date: Date,
  tz?: string,
): WallClockFields {
  if (!tz) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      minute: date.getMinutes(),
      hour: date.getHours(),
    };
  }

  let formatter = timezoneFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      hourCycle: "h23", // 0-23, avoids hour12:false quirks in some runtimes
    });
    timezoneFormatters.set(tz, formatter);
  }
  const parts = formatter.formatToParts(date);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

export function computeNextRunTime(expression: string, base?: Date, timezone?: string): number {
  const now = base ?? new Date();
  const parts = expression.trim().split(/\s+/);
  if (!validateCronExpression(expression)) throw new Error(`Invalid cron expression: ${expression}`);

  const minutes = [...parseField(parts[0]!, 0, 59)].sort((a, b) => a - b);
  const hours = [...parseField(parts[1]!, 0, 23)].sort((a, b) => a - b);
  const dayOfMonth = parseField(parts[2]!, 1, 31);
  const months = parseField(parts[3]!, 1, 12);
  const dayOfWeek = new Set([...parseField(parts[4]!, 0, 7)].map((value) => value % 7));
  const anyDayOfMonth = parts[2] === "*";
  const anyDayOfWeek = parts[4] === "*";
  const current = getTimezoneFields(now, timezone);
  const calendar = new Date(Date.UTC(current.year, current.month - 1, current.day));

  for (let offset = 0; offset < 366 * 5; offset++) {
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();
    const domMatches = dayOfMonth.has(day);
    const dowMatches = dayOfWeek.has(calendar.getUTCDay());
    const dayMatches = anyDayOfMonth
      ? anyDayOfWeek || dowMatches
      : anyDayOfWeek
        ? domMatches
        : domMatches || dowMatches;

    if (months.has(month) && dayMatches) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = wallClockToTimestamp({ year, month, day, hour, minute }, timezone);
          if (candidate !== undefined && candidate > now.getTime()) return candidate;
        }
      }
    }
    calendar.setUTCDate(calendar.getUTCDate() + 1);
  }

  throw new Error(`Cron expression has no matching time in the next five years: ${expression}`);
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  const segments = field.split(",");
  if (segments.some((segment) => segment.length === 0)) return values;
  for (const segment of segments) {
    const stepParts = segment.split("/");
    if (stepParts.length > 2) return new Set();
    const range = stepParts[0]!;
    const step = stepParts.length === 2 && /^\d+$/.test(stepParts[1]!) ? Number(stepParts[1]) : 1;
    if (!Number.isInteger(step) || step <= 0 || (stepParts.length === 2 && !/^\d+$/.test(stepParts[1]!))) {
      return new Set();
    }

    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (/^\d+$/.test(range)) {
      start = Number(range);
      end = stepParts.length === 2 ? max : start;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(range);
      if (!match) return new Set();
      start = Number(match[1]);
      end = Number(match[2]);
    }
    if (start < min || end > max || start > end) return new Set();
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function wallClockToTimestamp(fields: WallClockFields, timezone?: string): number | undefined {
  if (!timezone) {
    const date = new Date(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, 0, 0);
    return sameWallClock(getTimezoneFields(date), fields) ? date.getTime() : undefined;
  }

  const target = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = getTimezoneFields(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const adjustment = target - actualAsUtc;
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  return sameWallClock(getTimezoneFields(new Date(candidate), timezone), fields) ? candidate : undefined;
}

function sameWallClock(left: WallClockFields, right: WallClockFields): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}
