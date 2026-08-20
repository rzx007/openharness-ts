import { Hono } from "hono";

import type { JobReadResult } from "@openharness/jobs";

import { SessionTaskError, type SessionTaskService } from "../session/index.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export interface BackgroundShellRoutesContext {
  tasks: Pick<SessionTaskService, "create" | "stop">;
  jobs: { read(input: { sessionId: string; jobId: string }): Promise<JobReadResult> };
}

export function createBackgroundShellRoutes(context: BackgroundShellRoutesContext): Hono {
  return new Hono().post("/", async (c) => {
    const body = await readJson(c);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!sessionId) return errorResponse(400, "sessionId is required");
    if (!command) return errorResponse(400, "command is required");
    let task: Awaited<ReturnType<SessionTaskService["create"]>>["task"];
    try {
      ({ task } = await context.tasks.create({
        sessionId,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        command,
        description: typeof body.description === "string" ? body.description : undefined,
      }));
    } catch (error) {
      const status = error instanceof SessionTaskError ? error.status : 500;
      return errorResponse(status, errorMessage(error));
    }

    try {
      const result = await context.jobs.read({ sessionId, jobId: task.id });
      return jsonResponse({ jobId: task.id, snapshot: result.snapshot }, 201);
    } catch (error) {
      try {
        await context.tasks.stop(task.id, { sessionId });
      } catch (cleanupError) {
        return errorResponse(
          500,
          `Failed to normalize created background Job ${task.id}: ${errorMessage(error)}; ` +
          `cleanup failed: ${errorMessage(cleanupError)}`,
        );
      }
      return errorResponse(500, errorMessage(error));
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
