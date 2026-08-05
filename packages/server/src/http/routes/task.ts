import { Hono } from "hono";

import { SessionTaskError, type SessionTaskService } from "../session-task-service.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export interface TaskRoutesContext {
  tasks: Pick<SessionTaskService, "create" | "get" | "list" | "stop">;
}

function taskErrorResponse(error: unknown, fallbackStatus: number): Response {
  const status = error instanceof SessionTaskError ? error.status : fallbackStatus;
  return errorResponse(status, error instanceof Error ? error.message : String(error));
}

export function createTaskRoutes(context: TaskRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      try {
        return jsonResponse(context.tasks.list({
          cwd: c.req.query("cwd") ?? undefined,
          sessionId: c.req.query("sessionId") ?? undefined,
          status: c.req.query("status") ?? undefined,
        }));
      } catch (error) {
        return taskErrorResponse(error, 500);
      }
    })
    .post("/", async (c) => {
      const body = await readJson(c);
      try {
        const result = await context.tasks.create({
          cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
          command: typeof body.command === "string" ? body.command : "",
        });
        return jsonResponse(result, 201);
      } catch (error) {
        return taskErrorResponse(error, 400);
      }
    })
    .get("/:taskId", (c) => {
      const taskId = c.req.param("taskId");
      if (!taskId) return errorResponse(400, "taskId is required");
      try {
        return jsonResponse(context.tasks.get(taskId, {
          cwd: c.req.query("cwd") ?? undefined,
          sessionId: c.req.query("sessionId") ?? undefined,
        }));
      } catch (error) {
        return taskErrorResponse(error, 500);
      }
    })
    .post("/:taskId/stop", async (c) => {
      const taskId = c.req.param("taskId");
      if (!taskId) return errorResponse(400, "taskId is required");
      try {
        return jsonResponse(await context.tasks.stop(taskId, {
          cwd: c.req.query("cwd") ?? undefined,
          sessionId: c.req.query("sessionId") ?? undefined,
        }));
      } catch (error) {
        return taskErrorResponse(error, 404);
      }
    });
}
