import { AgentRunNotAcceptingInputError, type AgentRunHandle, type AgentSteerInput } from "@openharness/core";

export class RunInterruptedError extends Error {
  constructor(message = "Run interrupted") {
    super(message);
    this.name = "RunInterruptedError";
  }
}

export interface SessionRunWorkContext {
  signal: AbortSignal;
  registerHandle(handle: AgentRunHandle): Promise<void>;
}

export interface EnqueueRunOptions {
  sessionId: string;
  runId: string;
  work: (context: SessionRunWorkContext) => Promise<void>;
  onSteerRejected?(input: AgentSteerInput, error: AgentRunNotAcceptingInputError): string | Promise<string>;
}

export interface EnqueueRunResult {
  runId: string;
  sessionId: string;
  state: "running" | "queued";
  promise: Promise<void>;
}

export type SteerSessionResult =
  | { merged: false }
  | { merged: true; activeRunId: string; delivery: Promise<{ runId: string }> };

export interface InterruptSessionResult {
  activeRunId?: string;
  queuedRunIds: string[];
  interrupted: boolean;
}

interface PendingSteerRequest {
  input: AgentSteerInput;
  resolve(value: { runId: string }): void;
  reject(error: unknown): void;
}

interface RunTask {
  runId: string;
  sessionId: string;
  controller: AbortController;
  work: (context: SessionRunWorkContext) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
  handle?: AgentRunHandle;
  pendingSteers: PendingSteerRequest[];
  steerRequests: Set<PendingSteerRequest>;
  controlChain: Promise<void>;
  acceptingSteers: boolean;
  onSteerRejected?: EnqueueRunOptions["onSteerRejected"];
}

interface SessionLane {
  active?: RunTask;
  queue: RunTask[];
}

export class SessionRunCoordinator {
  private readonly lanes = new Map<string, SessionLane>();

  enqueue(options: EnqueueRunOptions): EnqueueRunResult {
    const lane = this.getLane(options.sessionId);
    const task = this.createTask(options);
    const state = lane.active ? "queued" : "running";
    if (lane.active) lane.queue.push(task);
    else this.startTask(lane, task);
    return {
      runId: task.runId,
      sessionId: task.sessionId,
      state,
      promise: task.promise,
    };
  }

  steer(sessionId: string, input: AgentSteerInput): SteerSessionResult {
    const lane = this.lanes.get(sessionId);
    if (!lane?.active || !lane.active.acceptingSteers) return { merged: false };
    let resolve!: PendingSteerRequest["resolve"];
    let reject!: PendingSteerRequest["reject"];
    const delivery = new Promise<{ runId: string }>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void delivery.catch(() => {});
    const request = { input, resolve, reject };
    lane.active.pendingSteers.push(request);
    lane.active.steerRequests.add(request);
    this.flushSteers(lane.active);
    return { merged: true, activeRunId: lane.active.runId, delivery };
  }

  interrupt(sessionId: string): InterruptSessionResult {
    const lane = this.lanes.get(sessionId);
    if (!lane) return { queuedRunIds: [], interrupted: false };

    const queuedRunIds = lane.queue.map((task) => task.runId);
    for (const task of lane.queue.splice(0)) {
      const error = new RunInterruptedError("Queued run interrupted");
      task.controller.abort();
      this.rejectSteers(task, error);
      task.reject(error);
    }

    const activeRunId = lane.active?.runId;
    if (lane.active) {
      this.rejectSteers(lane.active, new RunInterruptedError("Steered input interrupted"));
      lane.active.controller.abort();
      void lane.active.handle?.interrupt("Run interrupted");
    }
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
      lane = { queue: [] };
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
      pendingSteers: [],
      steerRequests: new Set(),
      controlChain: Promise.resolve(),
      acceptingSteers: true,
      onSteerRejected: options.onSteerRejected,
    };
  }

  private startTask(lane: SessionLane, task: RunTask): void {
    lane.active = task;
    void (async () => {
      try {
        if (task.controller.signal.aborted) throw new RunInterruptedError();
        await task.work({
          signal: task.controller.signal,
          registerHandle: async (handle) => {
            if (task.controller.signal.aborted) {
              await handle.interrupt("Run interrupted");
              throw new RunInterruptedError();
            }
            task.handle = handle;
            this.flushSteers(task);
            await task.controlChain;
          },
        });
        task.acceptingSteers = false;
        await task.controlChain;
        await this.recoverUndeliveredSteers(task);
        task.resolve();
      } catch (error) {
        task.acceptingSteers = false;
        this.rejectSteers(task, error);
        task.reject(error);
      } finally {
        if (lane.active === task) lane.active = undefined;
        const next = lane.queue.shift();
        if (next) this.startTask(lane, next);
        else if (!lane.active) this.lanes.delete(task.sessionId);
      }
    })();
  }

  private flushSteers(task: RunTask): void {
    if (!task.handle || task.pendingSteers.length === 0) return;
    const pending = task.pendingSteers.splice(0);
    task.controlChain = task.controlChain.then(async () => {
      for (const request of pending) {
        try {
          const receipt = await task.handle!.steer(request.input);
          request.resolve({ runId: receipt.runId });
        } catch (error) {
          if (task.controller.signal.aborted) {
            const interrupted = new RunInterruptedError("Steered input interrupted");
            request.reject(interrupted);
            throw interrupted;
          }
          if (
            !(error instanceof AgentRunNotAcceptingInputError) ||
            !task.onSteerRejected
          ) {
            request.reject(error);
            throw error;
          }
          try {
            const runId = await task.onSteerRejected(request.input, error);
            request.resolve({ runId });
          } catch (replacementError) {
            request.reject(replacementError);
            throw replacementError;
          }
        } finally {
          task.steerRequests.delete(request);
        }
      }
    }).catch((error) => {
      task.controller.abort(error);
      void task.handle?.interrupt(error instanceof Error ? error.message : String(error));
      throw error;
    });
    void task.controlChain.catch(() => {});
  }

  private rejectSteers(task: RunTask, error: unknown): void {
    for (const request of task.steerRequests) request.reject(error);
    task.steerRequests.clear();
    task.pendingSteers.splice(0);
  }

  private async recoverUndeliveredSteers(task: RunTask): Promise<void> {
    const pending = task.pendingSteers.splice(0);
    if (pending.length === 0) return;
    if (task.controller.signal.aborted) {
      const error = new RunInterruptedError("Steered input interrupted");
      for (const request of pending) {
        request.reject(error);
        task.steerRequests.delete(request);
      }
      return;
    }
    const error = new AgentRunNotAcceptingInputError(task.runId);
    for (const request of pending) {
      try {
        if (!task.onSteerRejected) {
          request.reject(error);
          continue;
        }
        const runId = await task.onSteerRejected(request.input, error);
        request.resolve({ runId });
      } catch (replacementError) {
        request.reject(replacementError);
        throw replacementError;
      } finally {
        task.steerRequests.delete(request);
      }
    }
  }
}
