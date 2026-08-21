import { randomUUID } from "node:crypto";

import type { ObservabilityEvent } from "../../shared/observability.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

export interface SessionChildExecutionBridge {
  registerChildExecution(input: {
    id: string;
    description: string;
    cwd: string;
    sessionId: string;
    childSessionId: string;
    prompt: string;
    onInput(data: string): Promise<void>;
    onStop(): Promise<void>;
  }): { id: string };
  bindChildExecutionRun(taskId: string, runId: string): Promise<void>;
  completeChildExecution(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped" | "interrupted"; output: string },
  ): Promise<unknown>;
}

export interface ExecutionInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  cwd: string;
  metadata: Record<string, unknown>;
}

type DurableTaskStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface ChildAgentRegistry {
  beginExecution(taskId: string): ExecutionInfo;
  completeExecution(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped"; output: string },
  ): Promise<unknown>;
  registerChildExecution(input: Parameters<SessionChildExecutionBridge["registerChildExecution"]>[0]): ExecutionInfo;
}

export interface DetachedProcessRuntime {
  listExecutions(status?: string): ExecutionInfo[];
  readOutput(executionId: string): string;
  registerExecutionListener(listener: (execution: ExecutionInfo) => void): void;
}

export type ChildAgentRegistryFactory = (scope: { cwd: string; sessionId: string }) => ChildAgentRegistry;

interface SessionTaskStore {
  createSessionTask(input: {
    id: string;
    sessionId: string;
    childSessionId?: string;
    type: string;
    description: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): unknown;
  findSessionExecutionByRuntimeId(sessionId: string, runtimeExecutionId: string): {
    id: string;
    sessionId: string;
  } | undefined;
  getSessionTask(taskId: string): {
    id: string;
    sessionId: string;
    status: DurableTaskStatus;
    runId?: string;
  } | undefined;
  updateSessionTask(taskId: string, input: {
    status: DurableTaskStatus;
    runId?: string;
    output?: string;
    error?: string;
  }): { sessionId: string };
}

export interface SessionExecutionProjectorContext {
  store: SessionTaskStore;
  getChildAgentExecutionRegistry: ChildAgentRegistryFactory;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}

/**
 * 为每个 session 生成 bridge：把 framework child Agent registry 与 store 的
 * SessionTask 持久化投影对齐。后台进程由 projectProcessExecutions 单独投影。
 */
export class SessionExecutionProjector {
  private readonly trackedTasks = new WeakMap<object, Set<string>>();

  constructor(private readonly context: SessionExecutionProjectorContext) {}

  createBridge(session: { id: string; cwd: string }): SessionChildExecutionBridge {
    const registry = this.context.getChildAgentExecutionRegistry({ cwd: session.cwd, sessionId: session.id });
    return {
      registerChildExecution: (input) => {
        const before = this.context.events.checkpoint();
        this.context.store.createSessionTask({
          id: input.id,
          sessionId: input.sessionId,
          childSessionId: input.childSessionId,
          type: "agent",
          description: input.description,
          cwd: input.cwd,
          metadata: {
            origin: "child_session",
            agent: input.description,
            executionBackend: "child_agent",
            runtimeExecutionId: input.id,
          },
        });
        let task: ExecutionInfo;
        try {
          task = registry.registerChildExecution(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.context.store.updateSessionTask(input.id, {
            status: "failed",
            output: message,
            error: message,
          });
          this.context.events.publishSince(before);
          throw error;
        }
        this.context.log({
          level: "info",
          event: "session.task.created",
          sessionId: input.sessionId,
          taskId: task.id,
        });
        this.context.events.publishSince(before);
        return { id: task.id };
      },
      bindChildExecutionRun: async (taskId, runId) => {
        const before = this.context.events.checkpoint();
        registry.beginExecution(taskId);
        const task = this.context.store.updateSessionTask(taskId, { status: "running", runId });
        this.context.log({
          level: "info",
          event: "session.task.bound",
          traceId: this.context.traceIdForRun(runId),
          sessionId: task.sessionId,
          runId,
          taskId,
        });
        this.context.events.publishSince(before);
      },
      completeChildExecution: async (taskId, input) => {
        const registryStatus = input.status === "interrupted" ? "stopped" : input.status;
        let task: unknown;
        let registryError: unknown;
        try {
          task = await registry.completeExecution(taskId, { ...input, status: registryStatus });
        } catch (error) {
          registryError = error;
        }
        const before = this.context.events.checkpoint();
        this.context.store.updateSessionTask(taskId, {
          status: input.status,
          output: input.output,
          ...(input.status === "failed" ? { error: input.output } : {}),
        });
        const persisted = this.context.store.getSessionTask(taskId);
        this.context.log({
          level: input.status === "failed" ? "error" : "info",
          event: "session.task.completed",
          ...(persisted?.runId ? {
            traceId: this.context.traceIdForRun(persisted.runId),
            runId: persisted.runId,
          } : {}),
          sessionId: persisted?.sessionId ?? session.id,
          taskId,
          ...(input.status === "failed" ? { error: "task failed" } : {}),
        });
        this.context.events.publishSince(before);
        if (registryError) {
          this.context.log({
            level: "warn",
            event: "session.execution.registry_completion_failed",
            sessionId: persisted?.sessionId ?? session.id,
            taskId,
            error: registryError instanceof Error ? registryError.message : String(registryError),
          });
        }
        return task;
      },
    };
  }

  projectProcessExecutions(sessionId: string, runtime: DetachedProcessRuntime): void {
    for (const task of runtime.listExecutions()) {
      const persisted = this.context.store.findSessionExecutionByRuntimeId(sessionId, task.id);
      if (!persisted) {
        const sameId = this.context.store.getSessionTask(task.id);
        this.context.store.createSessionTask({
          id: sameId && sameId.sessionId !== sessionId ? `task_${randomUUID()}` : task.id,
          sessionId,
          childSessionId: typeof task.metadata.child_session_id === "string" ? task.metadata.child_session_id : undefined,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "detached_process", executionBackend: "detached_process", runtimeExecutionId: task.id },
        });
      }
      const durableTask = this.context.store.findSessionExecutionByRuntimeId(sessionId, task.id) ??
        this.context.store.getSessionTask(task.id);
      if (durableTask?.sessionId === sessionId) {
        this.trackProcessExecution(runtime, task.id, durableTask.id);
        this.syncPersistentExecution(task, runtime, durableTask.id);
      }
    }
  }

  trackProcessExecution(runtime: DetachedProcessRuntime, taskId: string, durableTaskId = taskId): void {
    const tracked = this.trackedTasks.get(runtime as object) ?? new Set<string>();
    if (tracked.has(taskId)) return;
    tracked.add(taskId);
    this.trackedTasks.set(runtime as object, tracked);
    runtime.registerExecutionListener((task) => {
      if (task.id !== taskId) return;
      const persisted = this.context.store.getSessionTask(durableTaskId);
      if (!persisted) return;
      this.syncPersistentExecution(task, runtime, durableTaskId);
    });
  }

  syncPersistentExecution(task: ExecutionInfo, runtime: DetachedProcessRuntime, durableTaskId = task.id): void {
    const status: DurableTaskStatus = task.status === "pending" || task.status === "running" ||
      task.status === "completed" || task.status === "failed" || task.status === "stopped" ? task.status : "failed";
    const persisted = this.context.store.getSessionTask(durableTaskId);
    if (
      persisted &&
      isTerminalTaskStatus(persisted.status) &&
      (status === "pending" || status === "running")
    ) return;
    let output: string | undefined;
    try { output = runtime.readOutput(task.id); } catch { /* output is optional */ }
    const before = this.context.events.checkpoint();
    this.context.store.updateSessionTask(durableTaskId, {
      status,
      ...(output !== undefined ? { output } : {}),
      ...(status === "failed" ? { error: output ?? "Task failed" } : {}),
    });
    this.context.events.publishSince(before);
  }
}

function isTerminalTaskStatus(status: DurableTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "interrupted";
}
