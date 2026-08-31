import { Hono } from "hono";
import {
  parseCreateSessionRequest,
  parseUpdateSessionRequest,
} from "@openharness/protocol";

import {
  applicationErrorResponse,
  errorResponse,
  jsonResponse,
  protocolValidationErrorResponse,
  readCursor,
  readJson,
  readLimit,
  sessionMutationErrorStatus,
} from "../support.js";
import type { RequestTraceRegistry } from "../control/index.js";
import type { SessionApplicationService } from "../../application/session/session-application-service.js";
import type { SessionQueryService } from "../../application/session/session-query-service.js";

export interface SessionRoutesContext {
  queries: Pick<
    SessionQueryService,
    | "getSession"
    | "getSessionState"
    | "listMessageParts"
    | "listMessages"
    | "listSessions"
  >;
  application: Pick<
    SessionApplicationService,
    | "admitPrompt"
    | "archiveSessionTree"
    | "createSession"
    | "deleteSessionTree"
    | "forkSession"
    | "getSession"
    | "updateSession"
  >;
  traces: Pick<RequestTraceRegistry, "get">;
}

export function createSessionRoutes(context: SessionRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      const sessions = context.queries.listSessions({
        cwd: c.req.query("cwd") ?? undefined,
        includeArchived: c.req.query("includeArchived") === "true",
        includeChildren: c.req.query("includeChildren") === "true",
        limit: readLimit(c.req.query("limit")),
      });
      return jsonResponse({ sessions });
    })
    .post("/", async (c) => {
      let input;
      try {
        input = parseCreateSessionRequest(await readJson(c));
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }
      const session = context.application.createSession(input);
      return jsonResponse({ session }, 201);
    })
    .get("/:sessionId", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.application.getSession(sessionId, { warm: true });
      if (!session) return errorResponse(404, "Session not found");
      return jsonResponse({ session });
    })
    .post("/:sessionId/fork", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      try {
        const session = context.application.forkSession(sessionId, {
          beforeMessageId:
            typeof body.beforeMessageId === "string"
              ? body.beforeMessageId
              : undefined,
          afterMessageId:
            typeof body.afterMessageId === "string"
              ? body.afterMessageId
              : undefined,
        });
        return jsonResponse({ session }, 201);
      } catch (error) {
        return applicationErrorResponse(error, 404);
      }
    })
    .patch("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      let input;
      try {
        input = parseUpdateSessionRequest(await readJson(c));
      } catch (error) {
        return protocolValidationErrorResponse(error);
      }
      try {
        const session = await context.application.updateSession(sessionId, input);
        return jsonResponse({ session });
      } catch (error) {
        return applicationErrorResponse(
          error,
          sessionMutationErrorStatus(error),
        );
      }
    })
    .get("/:sessionId/state", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        return jsonResponse(context.queries.getSessionState(sessionId));
      } catch (error) {
        return errorResponse(
          sessionMutationErrorStatus(error),
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .delete("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const session = await context.application.archiveSessionTree(sessionId);
        return jsonResponse({ session });
      } catch (error) {
        return applicationErrorResponse(error, 404);
      }
    })
    .delete("/:sessionId/hard", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const deletedSessionIds =
          await context.application.deleteSessionTree(sessionId);
        return jsonResponse({ deletedSessionIds });
      } catch (error) {
        return applicationErrorResponse(error, 404);
      }
    })
    .get("/:sessionId/messages", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const messages = context.queries.listMessages(sessionId, {
          afterSeq: readCursor(c),
          limit: readLimit(c.req.query("limit")),
        });
        return jsonResponse({ messages });
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .get("/:sessionId/parts", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const parts = context.queries.listMessageParts(sessionId, {
          afterSeq: readCursor(c),
          messageId: c.req.query("messageId") ?? undefined,
          limit: readLimit(c.req.query("limit")),
        });
        return jsonResponse({ parts });
      } catch (error) {
        return errorResponse(
          404,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
}
