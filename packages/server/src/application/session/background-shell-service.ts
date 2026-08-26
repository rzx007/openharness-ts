import { randomUUID } from "node:crypto";

import type { Settings } from "@openharness/core";

import type {
  DetachedProcessExecution,
  DetachedProcessSupervisor,
} from "@openharness/services/executions";

import type { SessionExecutionProjector } from "./session-execution-projector.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import { ApplicationError } from "../../shared/application-error.js";

type ProcessSupervisor = DetachedProcessSupervisor;
type TaskScope = { cwd: string; sessionId?: string };

interface BackgroundShellStore {
  getSession(sessionId: string): { cwd: string } | undefined;
  listSessionTasks(sessionId: string): Array<{
    id: string;
    sessionId: string;
    status: string;
    output?: string;
    metadata: Record<string, unknown>;
  }>;
  getSessionTask(taskId: string): {
    id: string;
    sessionId: string;
    output?: string;
    metadata: Record<string, unknown>;
  } | undefined;
  createSessionTask(input: {
    id: string;
    sessionId: string;
    type: string;
    description: string;
    cwd: string;
    metadata: Record<string, unknown>;
  }): unknown;
}

export class BackgroundShellError extends ApplicationError {
  constructor(
    status: 400 | 404,
    message: string,
  ) {
    super(status, message);
    this.name = "BackgroundShellError";
  }
}

export interface BackgroundShellServiceContext {
  store: BackgroundShellStore;
  executionProjector: Pick<
    SessionExecutionProjector,
    "projectProcessExecutions" | "syncPersistentExecution" | "trackProcessExecution"
  >;
  getDetachedProcessSupervisor(scope: TaskScope): ProcessSupervisor;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

/** Shared background-shell creation and control for HTTP and model-tool callers. */
export class BackgroundShellService {
  constructor(private readonly context: BackgroundShellServiceContext) {}

  list(input: { cwd?: string; sessionId?: string; status?: string }): { executions: unknown[] } {
    const scope = this.resolveScope(input);
    const manager = this.context.getDetachedProcessSupervisor(scope);
    if (scope.sessionId) {
      this.context.executionProjector.projectProcessExecutions(scope.sessionId, manager);
      const tasks = this.context.store.listSessionTasks(scope.sessionId);
      return { executions: input.status ? tasks.filter((task) => task.status === input.status) : tasks };
    }
    return { executions: manager.listExecutions(input.status) };
  }

  async create(input: {
    cwd?: string;
    sessionId?: string;
    command: string;
    description?: string;
    settings?: Settings;
    origin?: "http" | "tool";
  }): Promise<{ execution: DetachedProcessExecution }> {
    const scope = this.resolveScope(input);
    const command = input.command.trim();
    if (!command) throw new BackgroundShellError(400, "command is required");
    const description = input.description?.trim() || command;
    const id = scope.sessionId ? `task_${randomUUID()}` : undefined;
    const manager = this.context.getDetachedProcessSupervisor(scope);
    const task = await manager.startShellExecution({
      ...(id ? { id } : {}),
      command,
      description,
      cwd: scope.cwd,
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(input.settings ? { settings: input.settings } : {}),
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
          metadata: {
            origin: input.origin ?? "http",
            executionBackend: "detached_process",
            runtimeExecutionId: task.id,
          },
        });
        this.context.executionProjector.trackProcessExecution(manager, task.id);
        this.context.executionProjector.syncPersistentExecution(task, manager);
        this.context.events.publishSince(before);
      } catch (error) {
        try {
          const stopped = await manager.stopExecution(task.id);
          try {
            this.context.executionProjector.syncPersistentExecution(stopped, manager);
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
    return { execution: task };
  }

  get(taskId: string, input: { cwd?: string; sessionId?: string }): { execution: unknown; output?: string } {
    const scope = this.resolveScope(input);
    const manager = this.context.getDetachedProcessSupervisor(scope);
    if (scope.sessionId) {
      this.context.executionProjector.projectProcessExecutions(scope.sessionId, manager);
      const task = this.context.store.getSessionTask(taskId);
      if (!task || task.sessionId !== scope.sessionId) {
        throw new BackgroundShellError(404, `Task not found: ${taskId}`);
      }
      const managerTaskId = runtimeExecutionId(task);
      let output = task.output;
      try {
        output = manager.readOutput(managerTaskId);
      } catch {
        // Durable output remains available after a daemon restart.
      }
      return { execution: task, ...(output !== undefined ? { output } : {}) };
    }

    const task = manager.getExecution(taskId);
    if (!task) throw new BackgroundShellError(404, `Task not found: ${taskId}`);
    let output: string | undefined;
    try {
      output = manager.readOutput(taskId);
    } catch {
      output = undefined;
    }
    return { execution: task, ...(output !== undefined ? { output } : {}) };
  }

  async stop(taskId: string, input: { cwd?: string; sessionId?: string }): Promise<{ execution: unknown }> {
    const scope = this.resolveScope(input);
    const manager = this.context.getDetachedProcessSupervisor(scope);
    if (scope.sessionId) this.context.executionProjector.projectProcessExecutions(scope.sessionId, manager);
    const persisted = scope.sessionId ? this.context.store.getSessionTask(taskId) : undefined;
    const managerTaskId = persisted ? runtimeExecutionId(persisted) : taskId;
    const task = await manager.stopExecution(managerTaskId);
    if (scope.sessionId && persisted) {
      this.context.executionProjector.syncPersistentExecution(task, manager, persisted.id);
    }
    return { execution: task };
  }

  private resolveScope(input: { cwd?: string; sessionId?: string }): TaskScope {
    let cwd = input.cwd;
    if (input.sessionId) {
      const session = this.context.store.getSession(input.sessionId);
      if (!session) throw new BackgroundShellError(404, "Session not found");
      cwd = cwd ?? session.cwd;
    }
    if (!cwd) throw new BackgroundShellError(400, "cwd or sessionId is required");
    return { cwd, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
  }
}

function runtimeExecutionId(task: { id: string; metadata: Record<string, unknown> }): string {
  if (typeof task.metadata.runtimeExecutionId === "string") return task.metadata.runtimeExecutionId;
  if (typeof task.metadata.taskManagerId === "string") return task.metadata.taskManagerId;
  return task.id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
