import { randomUUID } from "node:crypto";

import { getTaskManager, type SessionStore, type TaskInfo } from "@openharness/services";

import type { SessionTaskBridgeManager } from "./session-task-bridge.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";

type TaskManager = ReturnType<typeof getTaskManager>;
type TaskScope = { cwd: string; sessionId?: string };

export class SessionTaskError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "SessionTaskError";
  }
}

export interface SessionTaskServiceContext {
  store: SessionStore;
  bridgeManager: Pick<
    SessionTaskBridgeManager,
    "projectManagerTasks" | "syncPersistentTask" | "trackTask"
  >;
  getTaskManager(scope: TaskScope): TaskManager;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

/** HTTP-facing task use cases over TaskManager and the durable session task projection. */
export class SessionTaskService {
  constructor(private readonly context: SessionTaskServiceContext) {}

  list(input: { cwd?: string; sessionId?: string; status?: string }): { tasks: unknown[] } {
    const scope = this.resolveScope(input);
    const manager = this.context.getTaskManager(scope);
    if (scope.sessionId) {
      this.context.bridgeManager.projectManagerTasks(scope.sessionId, manager);
      const tasks = this.context.store.listSessionTasks(scope.sessionId);
      return { tasks: input.status ? tasks.filter((task) => task.status === input.status) : tasks };
    }
    return { tasks: manager.listTasks(input.status) };
  }

  async create(input: {
    cwd?: string;
    sessionId?: string;
    command: string;
    description?: string;
  }): Promise<{ task: TaskInfo }> {
    const scope = this.resolveScope(input);
    const command = input.command.trim();
    if (!command) throw new SessionTaskError(400, "command is required");
    const description = input.description?.trim() || command;
    const id = scope.sessionId ? `task_${randomUUID()}` : undefined;
    const manager = this.context.getTaskManager(scope);
    const task = await manager.createShellTask({
      ...(id ? { id } : {}),
      command,
      description,
      cwd: scope.cwd,
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    });
    if (scope.sessionId) {
      try {
        const before = this.context.events.checkpoint();
        this.context.store.createSessionTask({
          id: task.id,
          sessionId: scope.sessionId,
          type: task.type,
          description: task.description,
          cwd: task.cwd,
          metadata: { origin: "http", taskManagerId: task.id },
        });
        this.context.bridgeManager.trackTask(manager, task.id);
        this.context.bridgeManager.syncPersistentTask(task, manager);
        this.context.events.publishSince(before);
      } catch (error) {
        try {
          const stopped = await manager.stopTask(task.id);
          try {
            this.context.bridgeManager.syncPersistentTask(stopped, manager);
          } catch {
            // Process cleanup succeeded. A missing/broken projection must not hide that fact.
          }
        } catch (cleanupError) {
          throw new Error(
            `Failed to project created session task ${task.id}: ${errorMessage(error)}; ` +
            `cleanup failed: ${errorMessage(cleanupError)}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    return { task };
  }

  get(taskId: string, input: { cwd?: string; sessionId?: string }): { task: unknown; output?: string } {
    const scope = this.resolveScope(input);
    const manager = this.context.getTaskManager(scope);
    if (scope.sessionId) {
      this.context.bridgeManager.projectManagerTasks(scope.sessionId, manager);
      const task = this.context.store.getSessionTask(taskId);
      if (!task || task.sessionId !== scope.sessionId) {
        throw new SessionTaskError(404, `Task not found: ${taskId}`);
      }
      const managerTaskId = typeof task.metadata.taskManagerId === "string" ? task.metadata.taskManagerId : task.id;
      let output = task.output;
      try {
        output = manager.readTaskOutput(managerTaskId);
      } catch {
        // Durable output remains available after a daemon restart.
      }
      return { task, ...(output !== undefined ? { output } : {}) };
    }

    const task = manager.getTask(taskId);
    if (!task) throw new SessionTaskError(404, `Task not found: ${taskId}`);
    let output: string | undefined;
    try {
      output = manager.readTaskOutput(taskId);
    } catch {
      output = undefined;
    }
    return { task, ...(output !== undefined ? { output } : {}) };
  }

  async stop(taskId: string, input: { cwd?: string; sessionId?: string }): Promise<{ task: unknown }> {
    const scope = this.resolveScope(input);
    const manager = this.context.getTaskManager(scope);
    if (scope.sessionId) this.context.bridgeManager.projectManagerTasks(scope.sessionId, manager);
    const persisted = scope.sessionId ? this.context.store.getSessionTask(taskId) : undefined;
    const managerTaskId = persisted && typeof persisted.metadata.taskManagerId === "string"
      ? persisted.metadata.taskManagerId
      : taskId;
    const task = await manager.stopTask(managerTaskId);
    if (scope.sessionId && persisted) {
      this.context.bridgeManager.syncPersistentTask(task, manager, persisted.id);
    }
    return { task };
  }

  private resolveScope(input: { cwd?: string; sessionId?: string }): TaskScope {
    let cwd = input.cwd;
    if (input.sessionId) {
      const session = this.context.store.getSession(input.sessionId);
      if (!session) throw new SessionTaskError(404, "Session not found");
      cwd = cwd ?? session.cwd;
    }
    if (!cwd) throw new SessionTaskError(400, "cwd or sessionId is required");
    return { cwd, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
