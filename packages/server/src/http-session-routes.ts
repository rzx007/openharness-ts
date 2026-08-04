import { Hono } from "hono";

import type { SessionStore } from "@openharness/services";

import {
  normalizeCommandName,
  parseSlashLine,
  type CommandCatalogProvider,
} from "./commands.js";
import {
  errorResponse,
  isRecord,
  jsonResponse,
  readCursor,
  readJson,
  readLimit,
  runtimeSessionMetadataChanged,
  sessionMutationErrorStatus,
} from "./http-support.js";

type AdmitPromptResult = {
  input: ReturnType<SessionStore["admitPrompt"]>;
  run?: ReturnType<SessionStore["createRun"]>;
  queue_state?: "running" | "queued";
};

export interface SessionRoutesContext {
  store: Pick<
    SessionStore,
    | "createSession"
    | "getSession"
    | "getSessionState"
    | "listMessageParts"
    | "listMessages"
    | "listSessions"
    | "resolveSessionListTitle"
    | "updateSession"
  >;
  commandCatalog?: CommandCatalogProvider;
  latestEventSeq(): number;
  broadcastSince(seq: number): void;
  warmRuntime(sessionId: string): Promise<void>;
  hasRunWork(sessionId: string): boolean;
  closeRuntime(sessionId: string): Promise<void>;
  archiveSessionTree(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>>;
  traceIdForRequest(request: Request): string;
  admitPromptAndMaybeRun(
    sessionId: string,
    input: {
      content: string;
      metadata?: Record<string, unknown>;
      traceId?: string;
    },
  ): AdmitPromptResult;
}

export function createSessionRoutes(context: SessionRoutesContext): Hono {
  return new Hono()
    .get("/", (c) => {
      let sessions = context.store.listSessions({
        cwd: c.req.query("cwd") ?? undefined,
        includeArchived: c.req.query("includeArchived") === "true",
        limit: readLimit(c.req.query("limit")),
      });
      if (c.req.query("includeChildren") !== "true") {
        sessions = sessions.filter((session) => !session.parentId);
      }
      sessions = sessions.map((session) => ({
        ...session,
        title: context.store.resolveSessionListTitle(session.id),
      }));
      return jsonResponse({ sessions });
    })
    .post("/", async (c) => {
      const before = context.latestEventSeq();
      const body = await readJson(c);
      if (typeof body.cwd !== "string") return errorResponse(400, "cwd is required");
      if (typeof body.model !== "string") return errorResponse(400, "model is required");

      const session = context.store.createSession({
        id: typeof body.id === "string" ? body.id : undefined,
        parentId: typeof body.parentId === "string" ? body.parentId : undefined,
        cwd: body.cwd,
        title: typeof body.title === "string" ? body.title : undefined,
        model: body.model,
        agent: typeof body.agent === "string" ? body.agent : undefined,
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
      });
      void context.warmRuntime(session.id);
      context.broadcastSince(before);
      return jsonResponse({ session }, 201);
    })
    .get("/:sessionId", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      void context.warmRuntime(sessionId);
      return jsonResponse({ session });
    })
    .patch("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const before = context.latestEventSeq();
      const body = await readJson(c);
      try {
        const existing = context.store.getSession(sessionId);
        if (!existing) return errorResponse(404, "Session not found");
        const nextMetadata = isRecord(body.metadata)
          ? { ...existing.metadata, ...body.metadata }
          : undefined;
        const runtimeMetadataChanged = nextMetadata && runtimeSessionMetadataChanged(existing.metadata, nextMetadata);
        if (runtimeMetadataChanged && context.hasRunWork(sessionId)) {
          return errorResponse(409, "Cannot update runtime session settings while a run is active");
        }
        const session = context.store.updateSession(sessionId, {
          title: typeof body.title === "string" ? body.title : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          agent: body.agent === null ? null : typeof body.agent === "string" ? body.agent : undefined,
          metadata: nextMetadata,
        });
        if (runtimeMetadataChanged) {
          await context.closeRuntime(sessionId);
        }
        context.broadcastSince(before);
        return jsonResponse({ session });
      } catch (error) {
        return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
      }
    })
    .get("/:sessionId/state", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        return jsonResponse(context.store.getSessionState(sessionId));
      } catch (error) {
        return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
      }
    })
    .delete("/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const session = await context.archiveSessionTree(sessionId);
        return jsonResponse({ session });
      } catch (error) {
        return errorResponse(404, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/:sessionId/messages", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const messages = context.store.listMessages(sessionId, {
          afterSeq: readCursor(c),
          limit: readLimit(c.req.query("limit")),
        });
        return jsonResponse({ messages });
      } catch (error) {
        return errorResponse(404, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/:sessionId/parts", (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      try {
        const parts = context.store.listMessageParts(sessionId, {
          afterSeq: readCursor(c),
          messageId: c.req.query("messageId") ?? undefined,
          limit: readLimit(c.req.query("limit")),
        });
        return jsonResponse({ parts });
      } catch (error) {
        return errorResponse(404, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/commands", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const body = await readJson(c);
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");

      let name = typeof body.name === "string" ? normalizeCommandName(body.name) : "";
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
        const expanded = await context.commandCatalog.expand({ cwd: session.cwd, name, args });
        if (!expanded) return errorResponse(404, `Unknown command: ${name}`);
        const admitted = context.admitPromptAndMaybeRun(sessionId, {
          content: expanded.prompt,
          metadata: {
            command: expanded.command.name,
            commandKind: expanded.command.kind,
            commandArgs: args,
          },
          traceId: context.traceIdForRequest(c.req.raw),
        });
        return jsonResponse({ ...admitted, command: expanded.command }, 202);
      } catch (error) {
        return errorResponse(sessionMutationErrorStatus(error), error instanceof Error ? error.message : String(error));
      }
    });
}
