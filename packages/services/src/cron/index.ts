export interface CronJob {
  id: string;
  expression: string;
  handler: () => void | Promise<void>;
  running: boolean;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  register(id: string, expression: string, handler: () => void | Promise<void>): CronJob {
    const job: CronJob = { id, expression, handler, running: false };
    this.jobs.set(id, job);
    return job;
  }

  start(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.running) return true;
    job.running = true;
    const ms = this.parseInterval(job.expression);
    this.timers.set(id, setInterval(() => { job.handler(); }, ms));
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

  private parseInterval(expression: string): number {
    const parts = expression.trim().split(/\s+/);
    if (parts.length === 1) {
      const minutes = parseInt(parts[0]!, 10);
      if (!isNaN(minutes) && minutes > 0) return minutes * 60_000;
    }
    return 60_000;
  }
}

export function validateCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*/,\-]+$/.test(p));
}
