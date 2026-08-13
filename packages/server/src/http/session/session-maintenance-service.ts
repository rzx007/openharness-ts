import type { SessionStore } from "@openharness/services";
import type { AgentRememberResult } from "@openharness/agent-runtime";

import { writeSessionExport, type SessionExportFormat } from "../../session/export-session.js";
import { rewindTranscript } from "../../session/rewind.js";
import type { SessionRunEngine } from "./session-run-engine.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";
import {
  DaemonOperationUnavailableError,
  type DaemonOperationGate,
  type DaemonOperationLease,
} from "../control/daemon-operation-gate.js";
import { agentMessagesToTranscript } from "../agent/agent-transcript.js";
import { estimateCostUsd } from "../../shared/usage.js";

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
  agentPool: AgentPool;
  liveChildren: Pick<LiveChildAgentDirectory, "has">;
  operationGate: Pick<DaemonOperationGate, "enter" | "tryEnterBarrier">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

/**
 * Session 维护用例：MCP/usage 检查、compact、rewind、export、remember 等。
 * 通常要求无 active/queued run；会 warm runtime 并在变更 transcript 后必要时关闭 runtime。
 */
export class SessionMaintenanceService {
  constructor(private readonly context: SessionMaintenanceServiceContext) {}

  async listMcpServers(sessionId: string): Promise<unknown[]> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.enterSessionOperation(session);
    try {
      return (await this.context.agentPool.acquireSession(sessionId)).inspect().mcpServers;
    } finally {
      lease.release();
    }
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
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.enterSessionOperation(session);
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      const usage = agent.getUsage();
      return {
        model: session.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        messageCount: agent.getHistory().length,
        estimatedCost: estimateCostUsd(session.model, usage.inputTokens, usage.outputTokens),
      };
    } finally {
      lease.release();
    }
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
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.acquireSessionBarrier(session.id, session.cwd, "Cannot compact while a run is active");
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      const before = this.context.events.checkpoint();
      const compacted = await agent.compact();
      const replaced = this.context.store.replaceTranscript({
        sessionId,
        messages: agentMessagesToTranscript(compacted.history),
      });
      this.context.events.publishSince(before);
      return {
        messageCount: compacted.afterMessageCount,
        messages: replaced.messages,
        parts: replaced.parts,
      };
    } finally {
      lease.release();
    }
  }

  async rewind(sessionId: string, count: number): Promise<{
    turns: number;
    removed: number;
    messages: ReturnType<SessionStore["replaceTranscript"]>["messages"];
    parts: ReturnType<SessionStore["replaceTranscript"]>["parts"];
  }> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    const lease = this.acquireSessionBarrier(session.id, session.cwd, "Cannot rewind while a run is active");
    try {
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
      await this.context.agentPool.close(sessionId);
      this.context.events.publishSince(before);
      return {
        turns: rewound.turns,
        removed: rewound.removed,
        messages: replaced.messages,
        parts: replaced.parts,
      };
    } finally {
      lease.release();
    }
  }

  async remember(sessionId: string): Promise<AgentRememberResult> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.context.operationGate.tryEnterBarrier({ kind: "cwd", cwd: session.cwd }, () =>
      !this.context.runEngine.hasActiveRunsForCwd(session.cwd) &&
      !this.context.agentPool.hasActiveWorkForCwd(session.cwd));
    if (!lease) {
      throw new SessionMaintenanceError(409, "Cannot remember while session runs are active for this cwd");
    }
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      const result = await agent.remember();
      await this.context.agentPool.closeForCwd(session.cwd);
      return result;
    } finally {
      lease.release();
    }
  }

  private requireSession(sessionId: string): NonNullable<ReturnType<SessionStore["getSession"]>> {
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new SessionMaintenanceError(404, "Session not found");
    return session;
  }

  private requireRuntime(): void {
    if (!this.context.agentPool.configured) {
      throw new SessionMaintenanceError(501, "Agent runtime is not configured");
    }
  }

  private rejectLiveChild(sessionId: string): void {
    if (this.context.liveChildren.has(sessionId)) {
      throw new SessionMaintenanceError(409, "Cannot mutate or inspect a child runtime while it is live in its parent agent");
    }
  }

  private acquireSessionBarrier(sessionId: string, cwd: string, message: string): DaemonOperationLease {
    const lease = this.context.operationGate.tryEnterBarrier({ kind: "session", sessionId, cwd }, () =>
      !this.context.runEngine.hasWork(sessionId) &&
      !this.context.agentPool.hasActiveWorkForSession(sessionId));
    if (!lease) throw new SessionMaintenanceError(409, message);
    return lease;
  }

  private enterSessionOperation(
    session: Pick<NonNullable<ReturnType<SessionStore["getSession"]>>, "id" | "cwd">,
  ): DaemonOperationLease {
    try {
      return this.context.operationGate.enter({ sessionId: session.id, cwd: session.cwd });
    } catch (error) {
      if (error instanceof DaemonOperationUnavailableError) {
        throw new SessionMaintenanceError(409, error.message);
      }
      throw error;
    }
  }
}
