import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const execAsync = promisify(nodeExec);

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_MAX_CHARS = 10_000;

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

type HistoryEntry = {
  name: string;
  timestamp: number;
  success: boolean;
  output?: string;
};

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private history: HistoryEntry[] = [];
  private logDir?: string;

  constructor(logDir?: string) {
    this.logDir = logDir;
  }

  setLogDir(dir: string): void {
    this.logDir = dir;
  }

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
    name: string;
    expression: string;
    command: string;
    cwd?: string;
    timezone?: string;
    enabled?: boolean;
  }): CronJob {
    const existing = this.findByName(jobData.name);
    const id = existing?.id ?? `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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
      const delay = Math.max(0, computeNextRunTime(job.expression, undefined, job.timezone) - Date.now());
      const timer = setTimeout(async () => {
        let output: string | undefined;
        let success = true;
        try {
          if (job.command) {
            const result = await execAsync(job.command, {
              cwd: job.cwd,
              timeout: COMMAND_TIMEOUT_MS,
            });
            output = (result.stdout + result.stderr).trim().slice(0, OUTPUT_MAX_CHARS) || undefined;
          } else {
            const handler = job.handler ?? (() => {});
            await handler();
          }
          job.lastRun = Date.now();
        } catch (err) {
          success = false;
          output = String(err).slice(0, OUTPUT_MAX_CHARS);
        }

        const entry: HistoryEntry = { name: job.name, timestamp: Date.now(), success, output };
        this.history.push(entry);

        if (this.logDir && job.command) {
          const logLine = `[${new Date(entry.timestamp).toISOString()}] ${success ? "OK" : "FAIL"}${output ? " " + output : ""}\n`;
          const logPath = `${this.logDir}/${job.name}.log`;
          await mkdir(this.logDir, { recursive: true }).catch(() => {});
          await appendFile(logPath, logLine, "utf-8").catch(() => {});
        }

        job.nextRun = computeNextRunTime(job.expression, undefined, job.timezone);
        if (job.running) scheduleNext();
      }, delay);
      this.timers.set(id, timer);
    };

    job.nextRun = computeNextRunTime(job.expression, undefined, job.timezone);
    scheduleNext();
    return true;
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

  async saveHistory(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    for (const entry of this.history) {
      await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    }
    this.history = [];
  }

  /** Persist job definitions (without handler functions) to a JSON file. */
  async saveJobs(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const serializable = [...this.jobs.values()].map(({ handler: _h, running: _r, ...rest }) => rest);
    await writeFile(filePath, JSON.stringify(serializable, null, 2), "utf-8");
  }

  /** Load job definitions from a JSON file. Skips IDs already registered. */
  async loadJobs(filePath: string): Promise<number> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const jobs: CronJob[] = JSON.parse(raw);
      let count = 0;
      for (const job of jobs) {
        if (!this.jobs.has(job.id)) {
          this.jobs.set(job.id, { ...job, running: false, handler: undefined });
          count++;
        }
      }
      return count;
    } catch {
      return 0;
    }
  }
}

export function validateCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*/,\-]+$/.test(p));
}

/**
 * Returns the wall-clock fields (minute/hour/dom/month/dow) for `date` in the
 * given IANA timezone, or local time if `tz` is undefined/empty.
 */
function getTimezoneFields(
  date: Date,
  tz?: string,
): { minute: number; hour: number; dom: number; month: number; dow: number } {
  if (!tz) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dom: date.getDate(),
      month: date.getMonth() + 1,
      dow: date.getDay(),
    };
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
      hourCycle: "h23", // 0–23, avoids hour12:false quirks in some runtimes
    }).formatToParts(date);
    const get = (type: string): number => {
      const v = parts.find((p) => p.type === type)?.value ?? "0";
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? 0 : n % 24; // handle "24" for midnight
    };
    const DOW_MAP: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
    return {
      minute: get("minute"),
      hour: get("hour"),
      dom: get("day"),
      month: get("month"),
      dow: DOW_MAP[weekdayStr] ?? date.getDay(),
    };
  } catch {
    // Unknown timezone identifier: fall back to local time.
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dom: date.getDate(),
      month: date.getMonth() + 1,
      dow: date.getDay(),
    };
  }
}

/**
 * Compute the next UTC timestamp (ms) at which the cron expression fires.
 * The optional `timezone` parameter controls which timezone the expression is
 * evaluated in (e.g. `"Asia/Shanghai"`). Defaults to system local time.
 */
export function computeNextRunTime(expression: string, base?: Date, timezone?: string): number {
  const now = base ?? new Date();
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return now.getTime() + 60_000;

  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dayOfMonth = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dayOfWeek = parseField(parts[4]!, 0, 6);

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    const f = getTimezoneFields(next, timezone);
    if (
      minute.has(f.minute) &&
      hour.has(f.hour) &&
      dayOfMonth.has(f.dom) &&
      month.has(f.month) &&
      dayOfWeek.has(f.dow)
    ) {
      return next.getTime();
    }
    next.setMinutes(next.getMinutes() + 1);
  }

  return now.getTime() + 60_000;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    if (trimmed.includes("/")) {
      const [range, stepStr] = trimmed.split("/");
      const step = parseInt(stepStr!, 10);
      const start = range === "*" ? min : parseInt(range!, 10);
      for (let i = start; i <= max; i += step) values.add(i);
      continue;
    }
    if (trimmed.includes("-")) {
      const [lo, hi] = trimmed.split("-");
      for (let i = parseInt(lo!, 10); i <= parseInt(hi!, 10); i++) values.add(i);
      continue;
    }
    const val = parseInt(trimmed, 10);
    if (!isNaN(val)) values.add(val);
  }
  return values;
}

let _default: CronScheduler | undefined;

export function getCronScheduler(): CronScheduler {
  if (!_default) _default = new CronScheduler();
  return _default;
}
