import { randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import { getTaskManager, type TaskInfo } from "@openharness/services";

import { errorResponse, jsonResponse, readJson } from "./http-support.js";

type TaskManager = ReturnType<typeof getTaskManager>;
type TaskScope = { cwd: string; sessionId?: string };

export interface TaskRoutesContext {
  getSession(sessionId: string): { cwd: string } | undefined;
  listSessionTasks(sessionId: string): Array<{ status: string }>;
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
  latestEventSeq(): number;
  broadcastSince(seq: number): void;
  projectManagerTasks(sessionId: string, manager: TaskManager): void;
  trackTask(manager: TaskManager, taskId: string): void;
  syncPersistentTask(task: TaskInfo, manager: TaskManager, persistedId?: string): void;
}

export function createTaskRoutes(context: TaskRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      const scope = resolveTaskScope(context, c);
      if (scope instanceof Response) return scope;
      if (scope.sessionId) {
        const manager = getTaskManager(scope);
        context.projectManagerTasks(scope.sessionId, manager);
        const tasks = context.listSessionTasks(scope.sessionId);
        const status = c.req.query("status");
        return jsonResponse({ tasks: status ? tasks.filter((task) => task.status === status) : tasks });
      }
      const tasks = getTaskManager(scope).listTasks(c.req.query("status") ?? undefined);
      return jsonResponse({ tasks });
    })
    .post("/", async (c) => {
      const body = await readJson(c);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      let cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (sessionId) {
        const session = context.getSession(sessionId);
        if (!session) return errorResponse(404, "Session not found");
        cwd = cwd ?? session.cwd;
      }
      if (!cwd) return errorResponse(400, "cwd or sessionId is required");
      const command = typeof body.command === "string" ? body.command.trim() : "";
      if (!command) return errorResponse(400, "command is required");
      try {
        const id = sessionId ? `task_${randomUUID()}` : undefined;
        const manager = getTaskManager({ cwd, ...(sessionId ? { sessionId } : {}) });
        const task = await manager.createShellTask({
          ...(id ? { id } : {}),
          command,
          description: command,
          cwd,
          ...(sessionId ? { sessionId } : {}),
        });
        if (sessionId) {
          const before = context.latestEventSeq();
          context.createSessionTask({
            id: task.id,
            sessionId,
            type: task.type,
            description: task.description,
            cwd: task.cwd,
            metadata: { origin: "http", taskManagerId: task.id },
          });
          context.trackTask(manager, task.id);
          context.syncPersistentTask(task, manager);
          context.broadcastSince(before);
        }
        return jsonResponse({ task }, 201);
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/:taskId", (c) => {
      const taskId = c.req.param("taskId");
      if (!taskId) return errorResponse(400, "taskId is required");
      const scope = resolveTaskScope(context, c);
      if (scope instanceof Response) return scope;
      const manager = getTaskManager(scope);
      if (scope.sessionId) {
        context.projectManagerTasks(scope.sessionId, manager);
        const task = context.getSessionTask(taskId);
        if (!task || task.sessionId !== scope.sessionId) return errorResponse(404, `Task not found: ${taskId}`);
        const managerTaskId = typeof task.metadata.taskManagerId === "string" ? task.metadata.taskManagerId : task.id;
        let output = task.output;
        try { output = manager.readTaskOutput(managerTaskId); } catch { /* durable state remains available after restart */ }
        return jsonResponse({ task, ...(output !== undefined ? { output } : {}) });
      }
      const task = manager.getTask(taskId);
      if (!task) return errorResponse(404, `Task not found: ${taskId}`);
      let output: string | undefined;
      try {
        output = manager.readTaskOutput(taskId);
      } catch {
        output = undefined;
      }
      return jsonResponse({ task, ...(output !== undefined ? { output } : {}) });
    })
    .post("/:taskId/stop", async (c) => {
      const taskId = c.req.param("taskId");
      if (!taskId) return errorResponse(400, "taskId is required");
      const scope = resolveTaskScope(context, c);
      if (scope instanceof Response) return scope;
      try {
        const manager = getTaskManager(scope);
        if (scope.sessionId) context.projectManagerTasks(scope.sessionId, manager);
        const persisted = scope.sessionId ? context.getSessionTask(taskId) : undefined;
        const managerTaskId = persisted && typeof persisted.metadata.taskManagerId === "string"
          ? persisted.metadata.taskManagerId
          : taskId;
        const task = await manager.stopTask(managerTaskId);
        if (scope.sessionId && persisted) {
          context.syncPersistentTask(task, manager, persisted.id);
        }
        return jsonResponse({ task });
      } catch (error) {
        return errorResponse(404, error instanceof Error ? error.message : String(error));
      }
    });
}

function resolveTaskScope(context: TaskRoutesContext, c: Context): TaskScope | Response {
  const sessionId = c.req.query("sessionId") ?? undefined;
  let cwd = c.req.query("cwd") ?? undefined;
  if (sessionId) {
    const session = context.getSession(sessionId);
    if (!session) return errorResponse(404, "Session not found");
    cwd = cwd ?? session.cwd;
  }
  if (!cwd) return errorResponse(400, "cwd or sessionId is required");
  return { cwd, ...(sessionId ? { sessionId } : {}) };
}
