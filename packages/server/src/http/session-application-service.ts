import type { CreateSessionInput, SessionRecord, SessionStore } from "@openharness/services";

import type {
  AdmitPromptInput,
  AdmitPromptResult,
  AwaitSessionRunResult,
  SessionRunEngine,
} from "./session-run-engine.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionRuntimePool } from "./session-runtime-pool.js";
import { isRecord, runtimeSessionMetadataChanged } from "./support.js";

export class SessionApplicationError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SessionApplicationError";
  }
}

export interface SessionApplicationServiceContext {
  store: SessionStore;
  runEngine: SessionRunEngine;
  runtimePool: SessionRuntimePool;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

export interface UpdateSessionCommand {
  title?: string;
  model?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ResumeSessionRunCommand {
  id?: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}

export type ResumeSessionRunResult = AdmitPromptResult & {
  source_run: NonNullable<ReturnType<SessionStore["getRun"]>>;
};

export type CreateChildSessionCommand = Omit<CreateSessionInput, "parentId" | "title" | "agent" | "model"> & {
  parentId: string;
  title: string;
  agent: string;
  model?: string;
};

/**
 * Session 应用用例门面（HTTP 与 child session 共用）：
 * 创建/更新/归档 session、admitPrompt、resume、interrupt、awaitRun、createChildSession 等写路径编排。
 */
export class SessionApplicationService {
  private readonly archivePromises = new Map<string, Promise<ReturnType<SessionStore["archiveSession"]>>>();

  constructor(private readonly context: SessionApplicationServiceContext) {}

  get hasRuntime(): boolean {
    return this.context.runtimePool.configured;
  }

  createSession(input: Parameters<SessionStore["createSession"]>[0]): ReturnType<SessionStore["createSession"]> {
    const before = this.context.events.checkpoint();
    const session = this.context.store.createSession(input);
    void this.context.runtimePool.warm(session.id);
    this.context.events.publishSince(before);
    return session;
  }

  getSession(sessionId: string, options: { warm?: boolean } = {}): ReturnType<SessionStore["getSession"]> {
    const session = this.context.store.getSession(sessionId);
    if (session && options.warm) void this.context.runtimePool.warm(sessionId);
    return session;
  }

  async updateSession(
    sessionId: string,
    input: UpdateSessionCommand,
  ): Promise<ReturnType<SessionStore["updateSession"]>> {
    const existing = this.context.store.getSession(sessionId);
    if (!existing) throw new SessionApplicationError(404, "Session not found");
    const metadata = input.metadata
      ? { ...existing.metadata, ...input.metadata }
      : undefined;
    const runtimeMetadataChanged = metadata && runtimeSessionMetadataChanged(existing.metadata, metadata);
    if (runtimeMetadataChanged && this.context.runEngine.hasWork(sessionId)) {
      throw new SessionApplicationError(409, "Cannot update runtime session settings while a run is active");
    }

    const before = this.context.events.checkpoint();
    const session = this.context.store.updateSession(sessionId, {
      title: input.title,
      model: input.model,
      agent: input.agent,
      metadata,
    });
    if (runtimeMetadataChanged) await this.context.runtimePool.close(sessionId);
    this.context.events.publishSince(before);
    return session;
  }

  admitPrompt(sessionId: string, input: AdmitPromptInput): AdmitPromptResult {
    return this.context.runEngine.admitPromptAndMaybeRun(sessionId, input);
  }

  resumeRun(
    sessionId: string,
    runId: string,
    input: ResumeSessionRunCommand,
  ): ResumeSessionRunResult {
    const sourceRun = this.context.store.getRun(runId);
    if (!sourceRun || sourceRun.sessionId !== sessionId) {
      throw new SessionApplicationError(404, "Interrupted run not found");
    }
    if (sourceRun.status !== "interrupted") {
      throw new SessionApplicationError(409, "Only interrupted runs can be resumed");
    }
    if (!sourceRun.inputId) {
      throw new SessionApplicationError(409, "This interrupted run has no prompt to replay");
    }
    const sourceInput = this.context.store.getInput(sourceRun.inputId);
    if (!sourceInput || sourceInput.sessionId !== sessionId) {
      throw new SessionApplicationError(409, "The original prompt is unavailable");
    }

    const existingRecovery = this.context.store.listInputs(sessionId).find((candidate) =>
      isRecord(candidate.metadata.recovery) && candidate.metadata.recovery.sourceRunId === sourceRun.id,
    );
    if (existingRecovery && existingRecovery.id === input.id) {
      const existingRun = this.context.store.findRunByInput(existingRecovery.id);
      return {
        input: existingRecovery,
        ...(existingRun ? { run: existingRun } : {}),
        ...(existingRun?.status === "running" ? { queue_state: "running" as const } : {}),
        ...(existingRun?.status === "pending" ? { queue_state: "queued" as const } : {}),
        source_run: sourceRun,
      };
    }
    if (existingRecovery) {
      throw new SessionApplicationError(409, `Interrupted run already has a recovery: ${sourceRun.id}`);
    }
    if (!this.hasRuntime) {
      throw new SessionApplicationError(409, "Session runtime is unavailable");
    }
    if (this.context.runEngine.hasWork(sessionId)) {
      throw new SessionApplicationError(409, "Wait for the active session run before resuming interrupted work");
    }

    const recovery = {
      kind: "prompt_replay",
      sourceRunId: sourceRun.id,
      sourceInputId: sourceInput.id,
    };
    const resumed = this.context.runEngine.admitPromptAndMaybeRun(sessionId, {
      id: input.id,
      content: sourceInput.content,
      metadata: { ...(input.metadata ?? {}), recovery },
      runMetadata: { recovery },
      traceId: input.traceId,
    });
    const before = this.context.events.checkpoint();
    this.context.store.appendEvent({
      type: "session.run.recovery_requested",
      sessionId,
      payload: {
        sourceRunId: sourceRun.id,
        sourceInputId: sourceInput.id,
        recoveryInputId: resumed.input.id,
        recoveryRunId: resumed.run?.id,
      },
    });
    this.context.events.publishSince(before);
    return { ...resumed, source_run: sourceRun };
  }

  interruptSession(sessionId: string): ReturnType<SessionRunEngine["interruptSession"]> {
    return this.context.runEngine.interruptSession(sessionId);
  }

  async awaitRun(sessionId: string, runId: string): Promise<AwaitSessionRunResult> {
    return await this.context.runEngine.awaitRun(sessionId, runId);
  }

  async closeRuntime(sessionId: string): Promise<void> {
    await this.context.runtimePool.close(sessionId);
  }

  async createChildSession(input: CreateChildSessionCommand): Promise<SessionRecord> {
    const parent = this.context.store.getSession(input.parentId);
    if (!parent) throw new Error(`Parent session not found: ${input.parentId}`);
    const before = this.context.events.checkpoint();
    const session = this.context.store.createSession({
      ...input,
      model: input.model ?? parent.model,
    });
    this.context.events.publishSince(before);
    await this.context.runtimePool.warm(session.id);
    return session;
  }

  async archiveSessionTree(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>> {
    const existing = this.archivePromises.get(sessionId);
    if (existing) return await existing;
    const archive = this.archiveSessionTreeWork(sessionId).finally(() => {
      if (this.archivePromises.get(sessionId) === archive) this.archivePromises.delete(sessionId);
    });
    this.archivePromises.set(sessionId, archive);
    return await archive;
  }

  private async archiveSessionTreeWork(sessionId: string): Promise<ReturnType<SessionStore["archiveSession"]>> {
    const children = this.context.store.listChildSessions(sessionId);
    for (const child of children) await this.archiveSessionTree(child.id);

    const beforeClosing = this.context.events.checkpoint();
    const current = this.context.store.getSession(sessionId);
    if (!current) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    if (current.status === "archived") return current;
    this.context.store.beginArchive(sessionId);
    this.context.events.publishSince(beforeClosing);
    const interrupted = this.context.runEngine.interruptSession(sessionId);
    const interruptedRunIds = [interrupted.activeRunId, ...interrupted.queuedRunIds]
      .filter((runId): runId is string => !!runId);
    await this.context.runEngine.waitForRuns(interruptedRunIds);
    await this.context.runtimePool.close(sessionId);
    const before = this.context.events.checkpoint();
    const session = this.context.store.archiveSession(sessionId);
    this.context.events.publishSince(before);
    return session;
  }
}
