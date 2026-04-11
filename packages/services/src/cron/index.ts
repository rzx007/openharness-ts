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
    job.running = true;
    const ms = 60_000;
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
}
