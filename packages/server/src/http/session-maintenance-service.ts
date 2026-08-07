import type { SessionStore } from "@openharness/services";

import { writeSessionExport, type SessionExportFormat } from "../export-session.js";
import { rewindTranscript } from "../rewind.js";
import type { SessionRememberResult } from "../runtime.js";
import type { SessionRunEngine } from "./session-run-engine.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionRuntimePool } from "./session-runtime-pool.js";
import { estimateCostUsd } from "../usage.js";

export class SessionMaintenanceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 501,
    message: string,
  ) {
    super(message);
    this.name = "SessionMaintenanceError";
  }
}

export interface SessionMaintenanceServiceContext {
  store: SessionStore;
  runEngine: Pick<SessionRunEngine, "hasActiveRunsForCwd" | "hasWork">;
  runtimePool: SessionRuntimePool;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

/**
 * Session 维护用例：MCP/usage 检查、compact、rewind、export、remember 等。
 * 通常要求无 active/queued run；会 warm runtime 并在变更 transcript 后必要时关闭 runtime。
 */
export class SessionMaintenanceService {
  constructor(private readonly context: SessionMaintenanceServiceContext) {}

  async listMcpServers(sessionId: string): Promise<unknown[]> {
    this.requireSession(sessionId);
    await this.context.runtimePool.warm(sessionId);
    const runtime = await this.context.runtimePool.get(sessionId);
    if (!runtime?.inspect) return [];
    return (await runtime.inspect()).mcpServers;
  }

  async getUsage(sessionId: string): Promise<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    messageCount: number;
    estimatedCost: string;
  }> {
    const session = this.requireSession(sessionId);
    const messageCount = this.context.store.listMessages(sessionId).length;
    await this.context.runtimePool.warm(sessionId);
    const runtime = await this.context.runtimePool.get(sessionId);
    const usage = runtime?.getUsage
      ? await runtime.getUsage()
      : { inputTokens: 0, outputTokens: 0, messageCount };
    return {
      model: session.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      messageCount: usage.messageCount ?? messageCount,
      estimatedCost: estimateCostUsd(session.model, usage.inputTokens, usage.outputTokens),
    };
  }

  async exportSession(
    sessionId: string,
    input: { format: SessionExportFormat; filename?: string },
  ): ReturnType<typeof writeSessionExport> {
    const session = this.requireSession(sessionId);
    return await writeSessionExport({
      session,
      messages: this.context.store.listMessages(sessionId),
      parts: this.context.store.listMessageParts(sessionId),
      format: input.format,
      filename: input.filename,
    });
  }

  async compact(sessionId: string): Promise<{
    messageCount: number;
    messages: ReturnType<SessionStore["replaceTranscript"]>["messages"];
    parts: ReturnType<SessionStore["replaceTranscript"]>["parts"];
  }> {
    this.requireSession(sessionId);
    this.requireRuntime();
    if (this.context.runEngine.hasWork(sessionId)) {
      throw new SessionMaintenanceError(409, "Cannot compact while a run is active");
    }
    await this.context.runtimePool.warm(sessionId);
    const runtime = await this.context.runtimePool.get(sessionId);
    if (!runtime?.compact) {
      throw new SessionMaintenanceError(501, "Session runtime does not support compact");
    }
    const before = this.context.events.checkpoint();
    const compacted = await runtime.compact();
    const replaced = this.context.store.replaceTranscript({
      sessionId,
      messages: compacted.transcript,
    });
    this.context.events.publishSince(before);
    return {
      messageCount: compacted.messageCount,
      messages: replaced.messages,
      parts: replaced.parts,
    };
  }

  async rewind(sessionId: string, count: number): Promise<{
    turns: number;
    removed: number;
    messages: ReturnType<SessionStore["replaceTranscript"]>["messages"];
    parts: ReturnType<SessionStore["replaceTranscript"]>["parts"];
  }> {
    this.requireSession(sessionId);
    if (this.context.runEngine.hasWork(sessionId)) {
      throw new SessionMaintenanceError(409, "Cannot rewind while a run is active");
    }
    const rewound = rewindTranscript(
      this.context.store.listMessages(sessionId),
      this.context.store.listMessageParts(sessionId),
      count,
    );
    if (rewound.removed === 0) {
      throw new SessionMaintenanceError(400, "No messages to rewind");
    }
    const before = this.context.events.checkpoint();
    const replaced = this.context.store.replaceTranscript({
      sessionId,
      messages: rewound.kept,
    });
    await this.context.runtimePool.close(sessionId);
    this.context.events.publishSince(before);
    return {
      turns: rewound.turns,
      removed: rewound.removed,
      messages: replaced.messages,
      parts: replaced.parts,
    };
  }

  async remember(sessionId: string): Promise<SessionRememberResult> {
    const session = this.requireSession(sessionId);
    this.requireRuntime();
    if (this.context.runEngine.hasActiveRunsForCwd(session.cwd)) {
      throw new SessionMaintenanceError(409, "Cannot remember while session runs are active for this cwd");
    }
    await this.context.runtimePool.warm(sessionId);
    const runtime = await this.context.runtimePool.get(sessionId);
    if (!runtime?.remember) {
      throw new SessionMaintenanceError(501, "Session runtime does not support remember");
    }
    const result = await runtime.remember();
    await this.context.runtimePool.closeForCwd(session.cwd);
    return result;
  }

  private requireSession(sessionId: string): NonNullable<ReturnType<SessionStore["getSession"]>> {
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionMaintenanceError(404, "Session not found");
    return session;
  }

  private requireRuntime(): void {
    if (!this.context.runtimePool.configured) {
      throw new SessionMaintenanceError(501, "Runtime factory is not configured");
    }
  }
}
