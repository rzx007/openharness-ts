export interface CronJob {
  id: string;
  name: string;
  expression: string;
  command: string;
  cwd?: string;
  enabled: boolean;
  running: boolean;
  handler?: () => void | Promise<void>;
  lastRun?: number;
  nextRun?: number;
  createdAt?: number;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private history: Array<{
    name: string;
    timestamp: number;
    success: boolean;
    output?: string;
  }> = [];

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
      enabled: jobData.enabled ?? true,
      running: false,
      handler: existing?.handler,
      lastRun: existing?.lastRun,
      nextRun: computeNextRunTime(jobData.expression),
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
    const ms = parseCronToInterval(job.expression);
    const handler = job.handler ?? (() => {});
    this.timers.set(
      id,
      setInterval(async () => {
        try {
          await handler();
          job.lastRun = Date.now();
          job.nextRun = computeNextRunTime(job.expression);
          this.history.push({
            name: job.name,
            timestamp: Date.now(),
            success: true,
          });
        } catch (err) {
          this.history.push({
            name: job.name,
            timestamp: Date.now(),
            success: false,
            output: String(err),
          });
        }
      }, ms),
    );
    return true;
  }

  stop(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    const job = this.jobs.get(id);
    if (job) job.running = false;
    return true;
  }

  stopAll(): void {
    for (const id of this.timers.keys()) {
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

  getHistory(limit = 50): Array<{
    name: string;
    timestamp: number;
    success: boolean;
    output?: string;
  }> {
    return this.history.slice(-limit);
  }

  clearHistory(): void {
    this.history = [];
  }

  async saveHistory(filePath: string): Promise<void> {
    const { mkdir, appendFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(filePath), { recursive: true });
    for (const entry of this.history) {
      await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    }
    this.history = [];
  }
}

export function validateCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*/,\-]+$/.test(p));
}

export function computeNextRunTime(expression: string, base?: Date): number {
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
    if (
      minute.has(next.getMinutes()) &&
      hour.has(next.getHours()) &&
      dayOfMonth.has(next.getDate()) &&
      month.has(next.getMonth() + 1) &&
      dayOfWeek.has(next.getDay())
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
      const start = parseInt(lo!, 10);
      const end = parseInt(hi!, 10);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }
    const val = parseInt(trimmed, 10);
    if (!isNaN(val)) values.add(val);
  }
  return values;
}

function parseCronToInterval(expression: string): number {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return 60_000;

  const minuteField = parts[0]!;
  if (minuteField.startsWith("*/")) {
    const step = parseInt(minuteField.slice(2), 10);
    if (!isNaN(step) && step > 0) return step * 60_000;
  }
  if (minuteField.includes(",")) {
    const values = minuteField.split(",").map((v) => parseInt(v, 10));
    if (values.length >= 2 && values.every((v) => !isNaN(v))) {
      const sorted = values.sort((a, b) => a - b);
      const minDiff = sorted[1]! - sorted[0]!;
      if (minDiff > 0) return minDiff * 60_000;
    }
  }

  return 60_000;
}

let _default: CronScheduler | undefined;

export function getCronScheduler(): CronScheduler {
  if (!_default) _default = new CronScheduler();
  return _default;
}
