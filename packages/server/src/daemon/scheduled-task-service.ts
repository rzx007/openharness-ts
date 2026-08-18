import {
  computeNextScheduledTime,
  type CreateScheduledTaskInput,
  type ScheduledRunRecord,
  type ScheduledTaskRecord,
  type SessionStore,
  type UpdateScheduledTaskInput,
} from "@openharness/services";

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DAEMON_RESTART_REASON =
  "Daemon restarted while the scheduled task was running";

export interface ScheduledTaskExecutionResult {
  sessionId: string;
  runId: string;
  summary: string;
}

export interface ScheduledTaskServiceOptions {
  store: SessionStore;
  execute(
    task: ScheduledTaskRecord,
    run: ScheduledRunRecord,
  ): Promise<ScheduledTaskExecutionResult>;
}

export class ScheduledTaskService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Map<string, Promise<ScheduledRunRecord>>();
  private shuttingDown = false;

  constructor(private readonly options: ScheduledTaskServiceOptions) {
    options.store.interruptActiveScheduledRuns(DAEMON_RESTART_REASON);
    for (const task of options.store.listScheduledTasks()) {
      const missedRun =
        task.status === "active" &&
        task.missedRunPolicy === "run_once" &&
        task.nextRunAt !== undefined &&
        task.nextRunAt <= Date.now();
      const restored = missedRun
        ? options.store.updateScheduledTask(task.id, { nextRunAt: Date.now() })
        : task.status === "active"
          ? this.recomputeNext(task)
          : task;
      this.install(restored);
    }
  }

  status(): {
    running: true;
    tasks: number;
    active: number;
    paused: number;
    executing: number;
    unread: number;
  } {
    const tasks = this.listTasks();
    return {
      running: true,
      tasks: tasks.length,
      active: tasks.filter((task) => task.status === "active").length,
      paused: tasks.filter((task) => task.status === "paused").length,
      executing: this.active.size,
      unread: this.options.store.listScheduledRuns({ unread: true, limit: 500 })
        .length,
    };
  }

  listTasks(
    options: { status?: ScheduledTaskRecord["status"] } = {},
  ): ScheduledTaskRecord[] {
    return this.options.store.listScheduledTasks(options);
  }

  getTask(id: string): ScheduledTaskRecord {
    const task = this.options.store.getScheduledTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    return task;
  }

  listRuns(
    options: { taskId?: string; unread?: boolean; limit?: number } = {},
  ): ScheduledRunRecord[] {
    return this.options.store.listScheduledRuns(options);
  }

  createTask(input: CreateScheduledTaskInput): ScheduledTaskRecord {
    this.assertAvailable();
    this.validateInput(input);
    const timestamp = Date.now();
    const nextRunAt =
      input.status === "paused" || input.status === "completed"
        ? undefined
        : computeNextScheduledTime(
            { format: input.recurrenceFormat, value: input.recurrence },
            {
              after: new Date(timestamp),
              anchor: new Date(timestamp),
              timezone: input.timezone,
            },
          );
    const task = this.options.store.createScheduledTask({
      ...input,
      nextRunAt,
    });
    this.install(task);
    return task;
  }

  updateTask(id: string, patch: UpdateScheduledTaskInput): ScheduledTaskRecord {
    this.assertAvailable();
    const current = this.getTask(id);
    const candidate = { ...current, ...patch } as ScheduledTaskRecord;
    this.validateInput(candidate);
    const scheduleChanged =
      patch.recurrence !== undefined ||
      patch.recurrenceFormat !== undefined ||
      patch.timezone !== undefined ||
      patch.status !== undefined;
    const nextRunAt =
      candidate.status === "active"
        ? scheduleChanged
          ? computeNextScheduledTime(
              {
                format: candidate.recurrenceFormat,
                value: candidate.recurrence,
              },
              {
                after: new Date(),
                anchor: new Date(candidate.createdAt),
                timezone: candidate.timezone,
              },
            )
          : current.nextRunAt
        : null;
    const task = this.options.store.updateScheduledTask(id, {
      ...patch,
      ...(scheduleChanged ? { nextRunAt } : {}),
    });
    this.install(task);
    return task;
  }

  removeTask(id: string): void {
    this.assertAvailable();
    if (this.active.has(id))
      throw new Error(`Scheduled task is running: ${id}`);
    this.clearTimer(id);
    if (!this.options.store.deleteScheduledTask(id)) {
      throw new Error(`Scheduled task not found: ${id}`);
    }
  }

  async trigger(id: string): Promise<ScheduledRunRecord> {
    this.assertAvailable();
    const task = this.getTask(id);
    return await this.startRun(task, "manual", Date.now());
  }

  markRunRead(id: string, unread = false): ScheduledRunRecord {
    return this.options.store.updateScheduledRun(id, { unread });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const id of this.timers.keys()) this.clearTimer(id);
    await Promise.allSettled(this.active.values());
  }

  private install(task: ScheduledTaskRecord): void {
    this.clearTimer(task.id);
    if (
      task.status !== "active" ||
      task.nextRunAt === undefined ||
      this.shuttingDown
    )
      return;
    const delay = Math.max(0, task.nextRunAt - Date.now());
    const timer = setTimeout(
      () => {
        this.timers.delete(task.id);
        if (Date.now() < task.nextRunAt!) {
          this.install(task);
          return;
        }
        void this.startRun(task, "scheduled", task.nextRunAt!).finally(() => {
          const latest = this.options.store.getScheduledTask(task.id);
          if (latest) this.install(latest);
        });
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    this.timers.set(task.id, timer);
  }

  private async startRun(
    task: ScheduledTaskRecord,
    cause: ScheduledRunRecord["cause"],
    scheduledFor: number,
  ): Promise<ScheduledRunRecord> {
    const existing = this.active.get(task.id);
    if (existing) {
      if (task.overlapPolicy === "queue")
        return await existing.then(() =>
          this.startRun(task, cause, scheduledFor),
        );
      const skipped = this.options.store.createScheduledRun({
        taskId: task.id,
        cause,
        scheduledFor,
      });
      return this.options.store.updateScheduledRun(skipped.id, {
        status: "skipped",
        summary: "Skipped because the previous scheduled run is still active",
        unread: true,
        finishedAt: Date.now(),
      });
    }
    const run = this.options.store.createScheduledRun({
      taskId: task.id,
      cause,
      scheduledFor,
    });
    const promise = this.executeRun(task, run);
    this.active.set(task.id, promise);
    try {
      return await promise;
    } finally {
      this.active.delete(task.id);
    }
  }

  private async executeRun(
    task: ScheduledTaskRecord,
    run: ScheduledRunRecord,
  ): Promise<ScheduledRunRecord> {
    this.options.store.updateScheduledRun(run.id, {
      status: "running",
      startedAt: Date.now(),
    });
    try {
      const result = await this.options.execute(task, run);
      const finished = this.options.store.updateScheduledRun(run.id, {
        status: "succeeded",
        sessionId: result.sessionId,
        runId: result.runId,
        summary: result.summary,
        unread: true,
        finishedAt: Date.now(),
      });
      this.finishTask(task, finished.finishedAt!, true);
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("requires user attention")
        ? "needs_attention"
        : "failed";
      const finished = this.options.store.updateScheduledRun(run.id, {
        status,
        error: message,
        ...(status === "needs_attention" ? { attentionReason: message } : {}),
        unread: true,
        finishedAt: Date.now(),
      });
      this.finishTask(task, finished.finishedAt!, false);
      return finished;
    }
  }

  private finishTask(
    task: ScheduledTaskRecord,
    finishedAt: number,
    succeeded: boolean,
  ): void {
    const runCount = task.runCount + 1;
    const shouldComplete =
      task.recurrenceFormat === "once" ||
      task.stopPolicy?.runOnce ||
      (task.stopPolicy?.stopWhenCompleted && succeeded) ||
      (task.stopPolicy?.maxRuns !== undefined &&
        runCount >= task.stopPolicy.maxRuns) ||
      (task.stopPolicy?.expiresAt !== undefined &&
        finishedAt >= task.stopPolicy.expiresAt);
    const nextRunAt = shouldComplete
      ? null
      : computeNextScheduledTime(
          { format: task.recurrenceFormat, value: task.recurrence },
          {
            after: new Date(finishedAt),
            anchor: new Date(task.createdAt),
            timezone: task.timezone,
          },
        );
    this.options.store.updateScheduledTask(task.id, {
      runCount,
      lastRunAt: finishedAt,
      nextRunAt,
      ...(shouldComplete ? { status: "completed" } : {}),
    });
  }

  private recomputeNext(task: ScheduledTaskRecord): ScheduledTaskRecord {
    try {
      const nextRunAt = computeNextScheduledTime(
        { format: task.recurrenceFormat, value: task.recurrence },
        {
          after: new Date(),
          anchor: new Date(task.createdAt),
          timezone: task.timezone,
        },
      );
      return this.options.store.updateScheduledTask(task.id, { nextRunAt });
    } catch {
      return this.options.store.updateScheduledTask(task.id, {
        status: "completed",
        nextRunAt: null,
      });
    }
  }

  private validateInput(
    input: CreateScheduledTaskInput | ScheduledTaskRecord,
  ): void {
    if (!input.name.trim()) throw new Error("Scheduled task name is required");
    if (!input.prompt.trim())
      throw new Error("Scheduled task prompt is required");
    if (input.destination === "chat" && !input.sessionId) {
      throw new Error("A chat scheduled task requires sessionId");
    }
    if (
      input.destination === "standalone" &&
      (input.projectPaths?.length ?? 0) === 0
    ) {
      throw new Error(
        "A standalone scheduled task requires at least one project path",
      );
    }
    if (
      input.executionMode === "worktree" &&
      input.destination !== "standalone"
    ) {
      throw new Error(
        "Worktree scheduled execution requires a standalone destination",
      );
    }
    if (
      input.destination === "chat" &&
      (input.model !== undefined ||
        input.effort !== undefined ||
        (input.permissionProfile !== undefined &&
          (input.permissionProfile.mode !== "workspace_write" ||
            input.permissionProfile.network !== undefined ||
            (input.permissionProfile.allowedTools?.length ?? 0) > 0 ||
            (input.permissionProfile.deniedTools?.length ?? 0) > 0)))
    ) {
      throw new Error(
        "Scheduled task runtime overrides require a standalone destination; chat tasks inherit their conversation runtime",
      );
    }
    if (
      input.permissionProfile &&
      !["read_only", "workspace_write", "full_access"].includes(
        input.permissionProfile.mode,
      )
    ) {
      throw new Error("Unknown scheduled task permission profile");
    }
    if (input.effort && !["low", "medium", "high"].includes(input.effort)) {
      throw new Error("Unknown scheduled task effort");
    }
    if (
      input.overlapPolicy &&
      !["skip", "queue"].includes(input.overlapPolicy)
    ) {
      throw new Error("Unknown scheduled task overlap policy");
    }
    if (
      input.missedRunPolicy &&
      !["skip", "run_once"].includes(input.missedRunPolicy)
    ) {
      throw new Error("Unknown scheduled task missed-run policy");
    }
    computeNextScheduledTime(
      { format: input.recurrenceFormat, value: input.recurrence },
      { after: new Date(), anchor: new Date(), timezone: input.timezone },
    );
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private assertAvailable(): void {
    if (this.shuttingDown)
      throw new Error("Scheduled task service is shutting down");
  }
}
