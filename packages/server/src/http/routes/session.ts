import { Hono } from "hono";
import {
  patchSessionRuntimeMetadata,
  readRuntimeMetadata,
} from "@openharness/services";

import {
  normalizeCommandName,
  parseSlashLine,
  type CommandCatalogProvider,
} from "../../commands/index.js";
import {
  errorResponse,
  isRecord,
  jsonResponse,
  readCursor,
  readJson,
  readLimit,
  sessionMutationErrorStatus,
} from "../support.js";
import type { RequestTraceRegistry } from "../control/index.js";
import {
  SessionApplicationError,
  type AdmitPromptResult,
  type SessionApplicationService,
  type SessionQueryService,
} from "../session/index.js";

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
  commandCatalog?: CommandCatalogProvider;
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
      const body = await readJson(c);
      if (typeof body.cwd !== "string")
        return errorResponse(400, "cwd is required");
      const rawMetadata = isRecord(body.metadata) ? body.metadata : {};
      const runtime = readRuntimeMetadata(rawMetadata);
      const model =
        typeof runtime.model === "string"
          ? runtime.model
          : typeof body.model === "string"
            ? body.model
            : undefined;
      if (!model) return errorResponse(400, "model is required");
      const metadata = patchSessionRuntimeMetadata(rawMetadata, { model });

      const session = context.application.createSession({
        id: typeof body.id === "string" ? body.id : undefined,
        parentId: typeof body.parentId === "string" ? body.parentId : undefined,
        projectId:
          typeof body.projectId === "string" ? body.projectId : undefined,
        cwd: body.cwd,
        title: typeof body.title === "string" ? body.title : undefined,
        model,
        agent: typeof body.agent === "string" ? body.agent : undefined,
        metadata,
      });
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
        const status =
          error instanceof SessionApplicationError ? error.status : 404;
        return errorResponse(
          status,
          error instanceof Error ? error.message : String(error),
        );
      }
    })
    .patch("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      if (body.model !== undefined) {
        return errorResponse(
          400,
          "model must be changed through metadata.runtime.model",
        );
      }
      const rawMetadata = isRecord(body.metadata) ? body.metadata : undefined;
      try {
        const session = await context.application.updateSession(sessionId, {
          title: typeof body.title === "string" ? body.title : undefined,
          agent:
            body.agent === null
              ? null
              : typeof body.agent === "string"
                ? body.agent
                : undefined,
          metadata: rawMetadata,
        });
        return jsonResponse({ session });
      } catch (error) {
        const status =
          error instanceof SessionApplicationError
            ? error.status
            : sessionMutationErrorStatus(error);
        return errorResponse(
          status,
          error instanceof Error ? error.message : String(error),
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
        const status =
          error instanceof SessionApplicationError ? error.status : 404;
        return errorResponse(
          status,
          error instanceof Error ? error.message : String(error),
        );
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
        const status =
          error instanceof SessionApplicationError ? error.status : 404;
        return errorResponse(
          status,
          error instanceof Error ? error.message : String(error),
        );
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
    })
    .post("/:sessionId/commands", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      const session = context.queries.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");

      let name =
        typeof body.name === "string" ? normalizeCommandName(body.name) : "";
      let args = typeof body.args === "string" ? body.args : "";
      if (!name && typeof body.line === "string") {
        const parsed = parseSlashLine(body.line);
        if (!parsed) return errorResponse(400, "line must be a slash command");
        name = parsed.name;
        args = parsed.args;
      }
      if (!name) return errorResponse(400, "name or line is required");

      if (!context.commandCatalog?.expand) {
        return errorResponse(400, "Command expansion is not available");
      }

      try {
        const expanded = await context.commandCatalog.expand({
          cwd: session.cwd,
          name,
          args,
        });
        if (!expanded) return errorResponse(404, `Unknown command: ${name}`);
        const admitted: AdmitPromptResult =
          await context.application.admitPrompt(sessionId, {
            content: expanded.prompt,
            metadata: {
              command: expanded.command.name,
              commandKind: expanded.command.kind,
              commandArgs: args,
            },
            traceId: context.traces.get(c.req.raw),
          });
        return jsonResponse({ ...admitted, command: expanded.command }, 202);
      } catch (error) {
        const status =
          error instanceof SessionApplicationError
            ? error.status
            : sessionMutationErrorStatus(error);
        return errorResponse(
          status,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
}
