import { Hono } from "hono";

import {
  errorResponse,
  isRecord,
  jsonResponse,
  readJson,
  sessionMutationErrorStatus,
} from "../support.js";
import type { RequestTraceRegistry } from "../request-trace-registry.js";
import { SessionApplicationError, type SessionApplicationService } from "../session-application-service.js";

export interface RunExecutionRoutesContext {
  application: Pick<
    SessionApplicationService,
    "admitPrompt" | "interruptSession" | "resumeRun"
  >;
  traces: Pick<RequestTraceRegistry, "get">;
}

export function createRunExecutionRoutes(context: RunExecutionRoutesContext): Hono {
  return new Hono()
    .post("/:sessionId/prompts", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      if (typeof body.content !== "string") return errorResponse(400, "content is required");

      try {
        const admitted = context.application.admitPrompt(sessionId, {
          id: typeof body.id === "string" ? body.id : undefined,
          delivery: body.delivery === "steer" ? "steer" : "queue",
          content: body.content,
          metadata: isRecord(body.metadata) ? body.metadata : undefined,
          traceId: context.traces.get(c.req.raw),
        });
        return jsonResponse(admitted, 202);
      } catch (error) {
        return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/runs/:runId/resume", async (c) => {
      const sessionId = c.req.param("sessionId");
      const runId = c.req.param("runId");
      if (!sessionId || !runId) return errorResponse(400, "sessionId and runId are required");
      const body = await readJson(c);
      if (body.id !== undefined && typeof body.id !== "string") return errorResponse(400, "id must be a string");
      if (body.metadata !== undefined && !isRecord(body.metadata)) return errorResponse(400, "metadata must be an object");

      try {
        const resumed = context.application.resumeRun(sessionId, runId, {
          id: typeof body.id === "string" ? body.id : undefined,
          metadata: isRecord(body.metadata) ? body.metadata : undefined,
          traceId: context.traces.get(c.req.raw),
        });
        return jsonResponse(resumed, 202);
      } catch (error) {
        const status = error instanceof SessionApplicationError ? error.status : sessionMutationErrorStatus(error);
        return errorResponse(status, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/interrupt", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      return jsonResponse(context.application.interruptSession(sessionId));
    });
}
