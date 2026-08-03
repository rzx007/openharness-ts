export class RunInterruptedError extends Error {
  constructor(message = "Run interrupted") {
    super(message);
    this.name = "RunInterruptedError";
  }
}

export interface SessionRunWorkContext {
  signal: AbortSignal;
  wakeCount(): number;
}

export interface EnqueueRunOptions {
  sessionId: string;
  runId: string;
  work: (context: SessionRunWorkContext) => Promise<void>;
}

export interface EnqueueRunResult {
  runId: string;
  sessionId: string;
  state: "running" | "queued";
  promise: Promise<void>;
}

export interface InterruptSessionResult {
  activeRunId?: string;
  queuedRunIds: string[];
  interrupted: boolean;
}

interface RunTask {
  runId: string;
  sessionId: string;
  controller: AbortController;
  work: (context: SessionRunWorkContext) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
  wakeCount: number;
}

interface SessionLane {
  active?: RunTask;
  queue: RunTask[];
  wakeCount: number;
}

export class SessionRunCoordinator {
  private readonly lanes = new Map<string, SessionLane>();

  enqueue(options: EnqueueRunOptions): EnqueueRunResult {
    const lane = this.getLane(options.sessionId);
    const task = this.createTask(options);
    const state = lane.active ? "queued" : "running";
    if (lane.active) {
      lane.queue.push(task);
    } else {
      this.startTask(lane, task);
    }
    return {
      runId: task.runId,
      sessionId: task.sessionId,
      state,
      promise: task.promise,
    };
  }

  mergeWake(sessionId: string): { merged: boolean; wakeCount: number; activeRunId?: string } {
    const lane = this.lanes.get(sessionId);
    if (!lane?.active) return { merged: false, wakeCount: 0 };
    lane.wakeCount++;
    lane.active.wakeCount++;
    return { merged: true, wakeCount: lane.wakeCount, activeRunId: lane.active.runId };
  }

  interrupt(sessionId: string): InterruptSessionResult {
    const lane = this.lanes.get(sessionId);
    if (!lane) return { queuedRunIds: [], interrupted: false };

    const queuedRunIds = lane.queue.map((task) => task.runId);
    for (const task of lane.queue.splice(0)) {
      task.controller.abort();
      task.reject(new RunInterruptedError("Queued run interrupted"));
    }

    const activeRunId = lane.active?.runId;
    if (lane.active) lane.active.controller.abort();
    return {
      ...(activeRunId ? { activeRunId } : {}),
      queuedRunIds,
      interrupted: !!activeRunId || queuedRunIds.length > 0,
    };
  }

  activeRunId(sessionId: string): string | undefined {
    return this.lanes.get(sessionId)?.active?.runId;
  }

  queuedRunIds(sessionId: string): string[] {
    return [...(this.lanes.get(sessionId)?.queue ?? [])].map((task) => task.runId);
  }

  hasWork(sessionId: string): boolean {
    const lane = this.lanes.get(sessionId);
    return !!lane?.active || (lane?.queue.length ?? 0) > 0;
  }

  private getLane(sessionId: string): SessionLane {
    let lane = this.lanes.get(sessionId);
    if (!lane) {
      lane = { queue: [], wakeCount: 0 };
      this.lanes.set(sessionId, lane);
    }
    return lane;
  }

  private createTask(options: EnqueueRunOptions): RunTask {
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      runId: options.runId,
      sessionId: options.sessionId,
      controller,
      work: options.work,
      resolve,
      reject,
      promise,
      wakeCount: 0,
    };
  }

  private startTask(lane: SessionLane, task: RunTask): void {
    lane.active = task;
    void (async () => {
      try {
        if (task.controller.signal.aborted) throw new RunInterruptedError();
        await task.work({
          signal: task.controller.signal,
          wakeCount: () => task.wakeCount,
        });
        task.resolve();
      } catch (error) {
        task.reject(error);
      } finally {
        if (lane.active === task) lane.active = undefined;
        const next = lane.queue.shift();
        if (next) {
          this.startTask(lane, next);
        } else if (!lane.active) {
          lane.wakeCount = 0;
          this.lanes.delete(task.sessionId);
        }
      }
    })();
  }
}
