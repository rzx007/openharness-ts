import { Hono } from "hono";

import type { SessionStore } from "@openharness/services";

import { writeSessionExport, type SessionExportFormat } from "./export-session.js";
import { errorResponse, jsonResponse, readJson } from "./http-support.js";
import { rewindTranscript } from "./rewind.js";
import type { SessionRuntime, SessionRuntimeFactory } from "./runtime.js";
import { estimateCostUsd } from "./usage.js";

export interface SessionUtilityRoutesContext {
  store: Pick<SessionStore, "getSession" | "listMessages" | "listMessageParts" | "replaceTranscript">;
  runtimeFactory?: SessionRuntimeFactory;
  hasRunWork(sessionId: string): boolean;
  hasActiveRunsForCwd(cwd: string): boolean;
  warmRuntime(sessionId: string): Promise<void>;
  runtimeForSession(sessionId: string): Promise<SessionRuntime | undefined>;
  latestEventSeq(): number;
  broadcastSince(seq: number): void;
  closeRuntime(sessionId: string): Promise<void>;
  closeRuntimesForCwd(cwd: string): Promise<void>;
}

export function createSessionUtilityRoutes(context: SessionUtilityRoutesContext): Hono {
  return new Hono()
    .get("/:sessionId/mcp", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      try {
        await context.warmRuntime(sessionId);
        const runtime = await context.runtimeForSession(sessionId);
        if (!runtime?.inspect) return jsonResponse({ servers: [] as unknown[] });
        const inspect = await runtime.inspect();
        return jsonResponse({ servers: inspect.mcpServers });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .get("/:sessionId/usage", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      const messageCount = context.store.listMessages(sessionId).length;
      try {
        await context.warmRuntime(sessionId);
        const runtime = await context.runtimeForSession(sessionId);
        const usage = runtime?.getUsage
          ? await runtime.getUsage()
          : {
            inputTokens: 0,
            outputTokens: 0,
            messageCount,
          };
        const estimatedCost = estimateCostUsd(
          session.model,
          usage.inputTokens,
          usage.outputTokens,
        );
        return jsonResponse({
          model: session.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          messageCount: usage.messageCount ?? messageCount,
          estimatedCost,
        });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/export", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      const body = await readJson(c);
      const forceJson = body.json === true || body.format === "json";
      const filename = typeof body.filename === "string" ? body.filename : undefined;
      const format: SessionExportFormat =
        forceJson || (filename?.endsWith(".json") ?? false) ? "json" : "md";
      try {
        const result = await writeSessionExport({
          session,
          messages: context.store.listMessages(sessionId),
          parts: context.store.listMessageParts(sessionId),
          format,
          filename,
        });
        return jsonResponse(result);
      } catch (error) {
        return errorResponse(400, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/compact", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      if (!context.runtimeFactory) return errorResponse(501, "Runtime factory is not configured");
      if (context.hasRunWork(sessionId)) {
        return errorResponse(409, "Cannot compact while a run is active");
      }
      try {
        await context.warmRuntime(sessionId);
        const runtime = await context.runtimeForSession(sessionId);
        if (!runtime?.compact) return errorResponse(501, "Session runtime does not support compact");
        const before = context.latestEventSeq();
        const compacted = await runtime.compact();
        const replaced = context.store.replaceTranscript({
          sessionId,
          messages: compacted.transcript,
        });
        context.broadcastSince(before);
        return jsonResponse({
          messageCount: compacted.messageCount,
          messages: replaced.messages,
          parts: replaced.parts,
        });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/rewind", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      if (context.hasRunWork(sessionId)) {
        return errorResponse(409, "Cannot rewind while a run is active");
      }
      const body = await readJson(c);
      const rawCount = body.count ?? 1;
      const count = typeof rawCount === "number" ? rawCount : Number.parseInt(String(rawCount), 10);
      if (!Number.isInteger(count) || count < 1) {
        return errorResponse(400, "count must be a positive integer");
      }
      try {
        const rewound = rewindTranscript(
          context.store.listMessages(sessionId),
          context.store.listMessageParts(sessionId),
          count,
        );
        if (rewound.removed === 0) return errorResponse(400, "No messages to rewind");
        const before = context.latestEventSeq();
        const replaced = context.store.replaceTranscript({
          sessionId,
          messages: rewound.kept,
        });
        await context.closeRuntime(sessionId);
        context.broadcastSince(before);
        return jsonResponse({
          turns: rewound.turns,
          removed: rewound.removed,
          messages: replaced.messages,
          parts: replaced.parts,
        });
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    })
    .post("/:sessionId/remember", async (c) => {
      const sessionId = c.req.param("sessionId");
      if (!sessionId) return errorResponse(400, "sessionId is required");
      const session = context.store.getSession(sessionId);
      if (!session) return errorResponse(404, "Session not found");
      if (!context.runtimeFactory) return errorResponse(501, "Runtime factory is not configured");
      if (context.hasActiveRunsForCwd(session.cwd)) {
        return errorResponse(409, "Cannot remember while session runs are active for this cwd");
      }
      try {
        await context.warmRuntime(sessionId);
        const runtime = await context.runtimeForSession(sessionId);
        if (!runtime?.remember) return errorResponse(501, "Session runtime does not support remember");
        const result = await runtime.remember();
        await context.closeRuntimesForCwd(session.cwd);
        return jsonResponse(result);
      } catch (error) {
        return errorResponse(500, error instanceof Error ? error.message : String(error));
      }
    });
}
