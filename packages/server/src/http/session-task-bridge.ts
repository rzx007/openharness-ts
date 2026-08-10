import { randomUUID } from "node:crypto";

import type { ObservabilityEvent } from "../observability.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

export interface SessionTaskBridge {
  registerSessionTask(input: {
    description: string;
    cwd: string;
    sessionId: string;
    childSessionId: string;
    prompt: string;
    onInput(data: string): Promise<void>;
    onStop(): Promise<void>;
  }): { id: string };
  bindSessionTaskRun(taskId: string, runId: string): Promise<void>;
  completeSessionTask(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped" | "interrupted"; output: string },
  ): Promise<unknown>;
  writeToSessionTask(taskId: string, data: string): Promise<void>;
}

export interface TaskInfo {
  id: string;
  type: string;
  status: string;
  description: string;
  cwd: string;
  metadata: Record<string, unknown>;
}

type DurableTaskStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface TaskManager {
  completeSessionTask(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped"; output: string },
  ): Promise<unknown>;
  listTasks(status?: string): TaskInfo[];
  readTaskOutput(taskId: string): string;
  registerSessionTask(input: Parameters<SessionTaskBridge["registerSessionTask"]>[0] & { id: string }): TaskInfo;
  registerTaskListener(listener: (task: TaskInfo) => void): void;
  writeToTask(taskId: string, data: string): Promise<void>;
}

export type TaskManagerFactory = (scope: { cwd: string; sessionId: string }) => TaskManager;

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
  findSessionTaskByManagerTaskId(sessionId: string, managerTaskId: string): {
    id: string;
    sessionId: string;
  } | undefined;
  getSessionTask(taskId: string): {
    id: string;
    sessionId: string;
    runId?: string;
  } | undefined;
  updateSessionTask(taskId: string, input: {
    status: DurableTaskStatus;
    runId?: string;
    output?: string;
    error?: string;
  }): { sessionId: string };
}

export interface SessionTaskBridgeManagerContext {
  store: SessionTaskStore;
  getTaskManager: TaskManagerFactory;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}

/**
 * 为每个 session 生成 SessionTaskBridge：把进程内 TaskManager 与 store 的
 * SessionTask 投影对齐（register/complete/bindRun/write），供 child session / Agent 使用。
 */
export class SessionTaskBridgeManager {
  constructor(private readonly context: SessionTaskBridgeManagerContext) {}

  createBridge(session: { id: string; cwd: string }): SessionTaskBridge {
    const manager = this.context.getTaskManager({ cwd: session.cwd, sessionId: session.id });
    return {
      registerSessionTask: (input) => {
        const task = manager.registerSessionTask({ ...input, id: `task_${randomUUID()}` });
        const before = this.context.events.checkpoint();
        this.context.store.createSessionTask({
          id: task.id,
          sessionId: input.sessionId,
          childSessionId: input.childSessionId,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "child_session", agent: task.description, taskManagerId: task.id },
        });
        this.context.log({
          level: "info",
          event: "session.task.created",
          sessionId: input.sessionId,
          taskId: task.id,
        });
        this.context.events.publishSince(before);
        return { id: task.id };
      },
      bindSessionTaskRun: async (taskId, runId) => {
        const before = this.context.events.checkpoint();
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
      completeSessionTask: async (taskId, input) => {
        const managerStatus = input.status === "interrupted" ? "stopped" : input.status;
        const task = await manager.completeSessionTask(taskId, { ...input, status: managerStatus });
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
        return task;
      },
      writeToSessionTask: async (taskId, data) => {
        await manager.writeToTask(taskId, data);
        const before = this.context.events.checkpoint();
        this.context.store.updateSessionTask(taskId, { status: "running" });
        this.context.events.publishSince(before);
      },
    };
  }

  projectManagerTasks(sessionId: string, manager: TaskManager): void {
    for (const task of manager.listTasks()) {
      const persisted = this.context.store.findSessionTaskByManagerTaskId(sessionId, task.id);
      if (!persisted) {
        const sameId = this.context.store.getSessionTask(task.id);
        this.context.store.createSessionTask({
          id: sameId && sameId.sessionId !== sessionId ? `task_${randomUUID()}` : task.id,
          sessionId,
          childSessionId: typeof task.metadata.child_session_id === "string" ? task.metadata.child_session_id : undefined,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "task_manager", taskManagerId: task.id },
        });
      }
      const durableTask = this.context.store.findSessionTaskByManagerTaskId(sessionId, task.id) ??
        this.context.store.getSessionTask(task.id);
      if (durableTask?.sessionId === sessionId) this.syncPersistentTask(task, manager, durableTask.id);
    }
  }

  trackTask(manager: TaskManager, taskId: string): void {
    manager.registerTaskListener((task) => {
      if (task.id !== taskId) return;
      const persisted = this.context.store.getSessionTask(taskId);
      if (!persisted) return;
      this.syncPersistentTask(task, manager, persisted.id);
    });
  }

  syncPersistentTask(task: TaskInfo, manager: TaskManager, durableTaskId = task.id): void {
    const status: DurableTaskStatus = task.status === "pending" || task.status === "running" ||
      task.status === "completed" || task.status === "failed" || task.status === "stopped" ? task.status : "failed";
    let output: string | undefined;
    try { output = manager.readTaskOutput(task.id); } catch { /* output is optional */ }
    const before = this.context.events.checkpoint();
    this.context.store.updateSessionTask(durableTaskId, {
      status,
      ...(output !== undefined ? { output } : {}),
      ...(status === "failed" ? { error: output ?? "Task failed" } : {}),
    });
    this.context.events.publishSince(before);
  }
}
