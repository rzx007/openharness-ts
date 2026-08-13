import { resolve } from "node:path";

import type { Settings } from "@openharness/core";
import { startSandboxRuntime } from "@openharness/sandbox";
import {
  computeNextRunTime,
  CronScheduler,
  executeCronJob,
  validateCronExpression,
  type CronExecutionCause,
  type CronJob,
  type CronJobRecord,
  type CronRunRecord,
  type CronTriggerResult,
  type SessionStore,
} from "@openharness/services";

const DAEMON_RESTART_CRON_REASON = "Daemon restarted while the cron job was running";

export interface SaveCronJobInput {
  name: string;
  expression: string;
  command: string;
  cwd: string;
  timezone?: string;
  enabled?: boolean;
}

export interface DaemonCronServiceOptions {
  store: SessionStore;
  getSettingsForCwd(cwd: string): Promise<Settings>;
}

export class DaemonCronService {
  private readonly scheduler: CronScheduler;
  private readonly activeByJob = new Map<string, { controller: AbortController; promise: Promise<CronTriggerResult> }>();
  private shuttingDown = false;

  constructor(private readonly options: DaemonCronServiceOptions) {
    options.store.interruptActiveCronRuns(DAEMON_RESTART_CRON_REASON);
    this.scheduler = new CronScheduler((job, cause) => this.startExecution(job, cause));
    for (const job of options.store.listCronJobs()) {
      const restored = options.store.updateCronJob(job.id, {
        nextRunAt: job.enabled
          ? computeNextRunTime(job.expression, undefined, job.timezone)
          : null,
      });
      this.install(restored);
    }
  }

  listJobs(): CronJobRecord[] {
    return this.options.store.listCronJobs();
  }

  listRuns(options: { name?: string; limit?: number } = {}): CronRunRecord[] {
    return this.options.store.listCronRuns({ jobName: options.name, limit: options.limit });
  }

  status(): { running: true; jobs: number; enabled: number; active: number } {
    const jobs = this.options.store.listCronJobs();
    return {
      running: true,
      jobs: jobs.length,
      enabled: jobs.filter((job) => job.enabled).length,
      active: this.activeByJob.size,
    };
  }

  saveJob(input: SaveCronJobInput): CronJobRecord {
    this.assertAvailable();
    const name = input.name.trim();
    const expression = input.expression.trim();
    const command = input.command.trim();
    if (!name) throw new Error("Cron job name is required");
    if (!validateCronExpression(expression)) {
      throw new Error('Cron expression must have 5 fields: "minute hour day month weekday"');
    }
    if (!command) throw new Error("Cron command is required");
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format();
      } catch {
        throw new Error(`Unknown timezone: ${input.timezone}`);
      }
    }
    const existing = this.options.store.getCronJobByName(name);
    const enabled = input.enabled ?? existing?.enabled ?? true;
    const job = this.options.store.upsertCronJob({
      name,
      expression,
      command,
      cwd: resolve(input.cwd),
      timezone: input.timezone,
      enabled,
      nextRunAt: enabled ? computeNextRunTime(expression, undefined, input.timezone) : undefined,
    });
    this.install(job);
    return job;
  }

  setEnabled(name: string, enabled: boolean): CronJobRecord {
    this.assertAvailable();
    const job = this.requireJob(name);
    const updated = this.options.store.updateCronJob(job.id, {
      enabled,
      nextRunAt: enabled ? computeNextRunTime(job.expression, undefined, job.timezone) : null,
    });
    this.install(updated);
    return updated;
  }

  removeJob(name: string): boolean {
    this.assertAvailable();
    const job = this.requireJob(name);
    if (this.activeByJob.has(job.id)) throw new Error(`Cron job is running: ${name}`);
    this.scheduler.removeJob(job.id);
    return this.options.store.deleteCronJob(job.id);
  }

  async trigger(name: string): Promise<CronRunRecord> {
    this.assertAvailable();
    const job = this.requireJob(name);
    if (this.activeByJob.has(job.id)) throw new Error(`Cron job is already running: ${name}`);
    await this.scheduler.trigger(name);
    return this.options.store.listCronRuns({ jobId: job.id, limit: 1 })[0]!;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.scheduler.stopAll();
    const active = [...this.activeByJob.values()];
    for (const execution of active) execution.controller.abort();
    await Promise.allSettled(active.map((execution) => execution.promise));
  }

  private install(record: CronJobRecord): void {
    const job = this.scheduler.upsertJob({
      id: record.id,
      name: record.name,
      expression: record.expression,
      command: record.command,
      cwd: record.cwd,
      timezone: record.timezone,
      enabled: record.enabled,
    });
    if (record.enabled) this.scheduler.start(job.id);
    else this.scheduler.stop(job.id);
  }

  private startExecution(job: CronJob, cause: CronExecutionCause): Promise<CronTriggerResult> {
    const existing = this.activeByJob.get(job.id);
    if (existing) {
      return Promise.resolve({
        name: job.name,
        timestamp: Date.now(),
        success: false,
        output: "Skipped because the previous run is still active",
      });
    }
    if (this.shuttingDown) {
      return Promise.resolve({
        name: job.name,
        timestamp: Date.now(),
        success: false,
        interrupted: true,
        output: "Daemon is shutting down",
      });
    }
    const controller = new AbortController();
    const promise = this.execute(job, cause, controller);
    this.activeByJob.set(job.id, { controller, promise });
    void promise.then(
      () => this.activeByJob.delete(job.id),
      () => this.activeByJob.delete(job.id),
    );
    return promise;
  }

  private async execute(
    job: CronJob,
    cause: CronExecutionCause,
    controller: AbortController,
  ): Promise<CronTriggerResult> {
    const run = this.options.store.createCronRun({ jobId: job.id, jobName: job.name, cause });
    let runtime: Awaited<ReturnType<typeof startSandboxRuntime>> | undefined;
    let result: CronTriggerResult;
    try {
      const cwd = job.cwd ?? process.cwd();
      const settings = await this.options.getSettingsForCwd(cwd);
      runtime = await startSandboxRuntime({ settings, cwd, sessionId: `cron:${job.id}` });
      result = await executeCronJob(job, cause, {
        cwd,
        settings,
        sessionId: `cron:${job.id}`,
        signal: controller.signal,
      });
    } catch (error) {
      result = {
        name: job.name,
        timestamp: Date.now(),
        success: false,
        ...(controller.signal.aborted ? { interrupted: true } : {}),
        output: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await runtime?.stop();
    } catch (error) {
      result = {
        ...result,
        success: false,
        output: [result.output, `Sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`]
          .filter(Boolean)
          .join("\n"),
      };
    }

    const status = result.interrupted ? "interrupted" : result.success ? "succeeded" : "failed";
    this.options.store.finishCronRun(run.id, {
      status,
      ...(result.output ? { output: result.output } : {}),
      ...(!result.success && result.output ? { error: result.output } : {}),
    });
    const current = this.options.store.getCronJob(job.id);
    if (current) {
      this.options.store.updateCronJob(job.id, {
        ...(result.success ? { lastRunAt: result.timestamp } : {}),
        nextRunAt: current.enabled
          ? computeNextRunTime(current.expression, undefined, current.timezone)
          : null,
      });
    }
    return result;
  }

  private requireJob(name: string): CronJobRecord {
    const job = this.options.store.getCronJobByName(name);
    if (!job) throw new Error(`Cron job not found: ${name}`);
    return job;
  }

  private assertAvailable(): void {
    if (this.shuttingDown) throw new Error("Daemon is shutting down");
  }
}
