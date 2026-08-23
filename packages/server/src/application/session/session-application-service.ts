import {
  type SessionStore,
} from "@openharness/services";
import {
  patchSessionRuntimeMetadata,
  readSessionRuntimeConfig,
  readRuntimeMetadata,
  type ReplaceTranscriptMessageInput,
} from "@openharness/protocol";

import type {
  AdmitPromptInput,
  AdmitPromptResult,
  AwaitSessionRunResult,
  SessionRunEngine,
} from "./session-run-engine.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";
import {
  DaemonOperationUnavailableError,
  type DaemonOperationGate,
  type DaemonOperationLease,
} from "../control/daemon-operation-gate.js";
import {
  isRecord,
  jsonEqual,
  runtimeSessionMetadataChanged,
  withoutTraceId,
} from "../support.js";
import { SessionApplicationError } from "./session-application-error.js";

export { SessionApplicationError } from "./session-application-error.js";

export interface SessionApplicationServiceContext {
  store: SessionStore;
  runEngine: SessionRunEngine;
  agentPool: AgentPool;
  liveChildren: Pick<LiveChildAgentDirectory, "has" | "send" | "interrupt">;
  operationGate: Pick<DaemonOperationGate, "enter" | "tryEnterBarrier">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  /** 应用启动恢复完成前，拒绝新的写操作。测试和独立服务可不提供。 */
  assertReady?(): void;
}

export interface UpdateSessionCommand {
  title?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ForkSessionCommand {
  beforeMessageId?: string;
  afterMessageId?: string;
}

export interface EditLatestPromptCommand {
  content: string;
  traceId: string;
}

export interface ResumeSessionRunCommand {
  id?: string;
  metadata?: Record<string, unknown>;
  traceId: string;
}

export type ResumeSessionRunResult = AdmitPromptResult & {
  source_run: NonNullable<ReturnType<SessionStore["getRun"]>>;
};

/** Session 写用例门面；child session 只由 framework 事件投影创建。 */
export class SessionApplicationService {
  private readonly archivePromises = new Map<
    string,
    Promise<ReturnType<SessionStore["archiveSession"]>>
  >();

  constructor(private readonly context: SessionApplicationServiceContext) {}

  get hasRuntime(): boolean {
    return this.context.agentPool.configured;
  }

  createSession(
    input: Parameters<SessionStore["createSession"]>[0],
  ): ReturnType<SessionStore["createSession"]> {
    this.assertReady();
    const before = this.context.events.checkpoint();
    const runtime = readRuntimeMetadata(input.metadata ?? {});
    const model =
      typeof runtime.model === "string" ? runtime.model : input.model;
    const session = this.context.store.createSession({
      ...input,
      model,
      metadata: patchSessionRuntimeMetadata(input.metadata ?? {}, { model }),
    });
    this.warmWhenAdmitted(session);
    this.context.events.publishSince(before);
    return session;
  }

  getSession(
    sessionId: string,
    options: { warm?: boolean } = {},
  ): ReturnType<SessionStore["getSession"]> {
    const session = this.context.store.getSession(sessionId);
    if (session && options.warm && !this.context.liveChildren.has(sessionId)) {
      this.warmWhenAdmitted(session);
    }
    return session;
  }

  forkSession(
    sessionId: string,
    input: ForkSessionCommand = {},
  ): ReturnType<SessionStore["createSession"]> {
    this.assertReady();
    const source = this.context.store.getSession(sessionId);
    if (!source)
      throw new SessionApplicationError(404, `Session not found: ${sessionId}`);

    const sourceMessages = this.context.store.listMessages(sessionId);
    const sourceParts = this.context.store.listMessageParts(sessionId);
    const beforeMessage = input.beforeMessageId
      ? sourceMessages.find((message) => message.id === input.beforeMessageId)
      : undefined;
    const afterMessage = input.afterMessageId
      ? sourceMessages.find((message) => message.id === input.afterMessageId)
      : undefined;
    if (input.beforeMessageId && !beforeMessage) {
      throw new SessionApplicationError(404, "Fork point not found");
    }
    if (input.afterMessageId && !afterMessage) {
      throw new SessionApplicationError(404, "Fork point not found");
    }

    const beforeSeq = beforeMessage?.seq ?? Number.POSITIVE_INFINITY;
    const afterSeq = afterMessage?.seq ?? Number.POSITIVE_INFINITY;
    const copiedMessages = sourceMessages.filter(
      (message) => message.seq < beforeSeq && message.seq <= afterSeq,
    );
    const transcript = copyTranscript(copiedMessages, sourceParts);
    const before = this.context.events.checkpoint();
    const metadata = forkSessionMetadata(source.metadata, {
      sourceSessionId: source.id,
      ...(input.beforeMessageId
        ? { beforeMessageId: input.beforeMessageId }
        : {}),
      ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
    });
    const fork = this.context.store.createSession({
      parentId: source.id,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      cwd: source.cwd,
      title: source.title ? `${source.title} fork` : "",
      model: source.model,
      ...(source.agent ? { agent: source.agent } : {}),
      metadata,
    });
    if (transcript.length > 0) {
      this.context.store.replaceTranscript({
        sessionId: fork.id,
        messages: transcript,
      });
    }
    this.warmWhenAdmitted(fork);
    this.context.events.publishSince(before);
    return this.context.store.getSession(fork.id) ?? fork;
  }

  async editLatestPrompt(
    sessionId: string,
    input: EditLatestPromptCommand,
  ): Promise<AdmitPromptResult> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session)
      throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const content = input.content.trim();
    if (!content) throw new SessionApplicationError(400, "content is required");
    if (this.context.runEngine.hasWork(sessionId)) {
      throw new SessionApplicationError(
        409,
        "Wait for the active session run before editing the latest prompt",
      );
    }
    const latestUserMessage = [...this.context.store.listMessages(sessionId)]
      .reverse()
      .find((message) => message.role === "user");
    if (!latestUserMessage) {
      throw new SessionApplicationError(
        409,
        "No user prompt is available to edit",
      );
    }

    const lease = this.enterSessionOperation(session);
    try {
      const messages = this.context.store
        .listMessages(sessionId)
        .filter((message) => message.seq < latestUserMessage.seq);
      const parts = this.context.store.listMessageParts(sessionId);
      const before = this.context.events.checkpoint();
      this.context.store.replaceTranscript({
        sessionId,
        messages: copyTranscript(messages, parts),
      });
      await this.context.agentPool.close(sessionId);
      this.context.events.publishSince(before);
      return await this.admitPromptWork(sessionId, {
        content,
        traceId: input.traceId,
        metadata: {
          edit: {
            kind: "latest_prompt",
            sourceMessageId: latestUserMessage.id,
          },
        },
      });
    } finally {
      lease.release();
    }
  }

  async updateSession(
    sessionId: string,
    input: UpdateSessionCommand,
  ): Promise<ReturnType<SessionStore["updateSession"]>> {
    this.assertReady();
    const existing = this.context.store.getSession(sessionId);
    if (!existing) throw new SessionApplicationError(404, "Session not found");
    const metadata = input.metadata
      ? mergeSessionMetadata(existing.metadata, input.metadata)
      : undefined;
    const runtimeMetadataChanged =
      metadata && runtimeSessionMetadataChanged(existing.metadata, metadata);
    const runtimeConfigurationChanged = Boolean(
      runtimeMetadataChanged ||
      (input.agent !== undefined &&
        (input.agent ?? undefined) !== existing.agent),
    );
    const lease = runtimeConfigurationChanged
      ? this.acquireSessionMutation(
          existing,
          "Cannot update runtime session settings while the session is active",
        )
      : undefined;

    try {
      const before = this.context.events.checkpoint();
      const nextModel = metadata
        ? readSessionRuntimeConfig({ ...existing, metadata }).model
        : undefined;
      const session = this.context.store.updateSession(sessionId, {
        title: input.title,
        model: nextModel,
        agent: input.agent,
        metadata,
      });
      if (runtimeConfigurationChanged)
        await this.context.agentPool.close(sessionId);
      this.context.events.publishSince(before);
      return session;
    } finally {
      lease?.release();
    }
  }

  async admitPrompt(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session)
      throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.enterSessionOperation(session);
    try {
      return await this.admitPromptWork(sessionId, input);
    } finally {
      lease.release();
    }
  }

  private async admitPromptWork(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    const delivery = input.delivery ?? "queue";
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
    };
    if (this.context.liveChildren.has(sessionId) && input.id) {
      const existing = this.context.store.getInput(input.id);
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          existing.content !== input.content ||
          existing.delivery !== delivery ||
          !jsonEqual(
            withoutTraceId(existing.metadata),
            withoutTraceId(metadata),
          )
        ) {
          throw new SessionApplicationError(
            409,
            `Prompt id is already used: ${input.id}`,
          );
        }
        return promptResult(this.context.store, existing);
      }
    }
    const live = await this.context.liveChildren.send(sessionId, {
      id: input.id,
      content: input.content,
      delivery,
      traceId: input.traceId,
      metadata: input.metadata,
    });
    if (live) {
      const admitted = this.context.store.getInput(live.inputId);
      const run = this.context.store.getRun(live.runId);
      const owningRun = this.context.store.findRunByInput(live.inputId);
      if (
        live.sessionId !== sessionId ||
        !admitted ||
        admitted.sessionId !== sessionId ||
        admitted.content !== input.content ||
        admitted.delivery !== delivery ||
        (input.id !== undefined && admitted.id !== input.id) ||
        !jsonEqual(withoutTraceId(admitted.metadata), withoutTraceId(metadata))
      ) {
        throw new SessionApplicationError(
          500,
          "Live child input projection did not match its framework receipt",
        );
      }
      if (
        !run ||
        run.sessionId !== sessionId ||
        !owningRun ||
        owningRun.id !== run.id ||
        owningRun.sessionId !== sessionId
      ) {
        throw new SessionApplicationError(
          500,
          "Live child run projection did not match its framework receipt",
        );
      }
      return {
        input: admitted,
        run,
        ...(run.status === "running"
          ? { queue_state: "running" as const }
          : {}),
        ...(run.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }
    return await this.context.runEngine.admitPromptAndMaybeRun(
      sessionId,
      input,
    );
  }

  async resumeRun(
    sessionId: string,
    runId: string,
    input: ResumeSessionRunCommand,
  ): Promise<ResumeSessionRunResult> {
    this.assertReady();
    const session = this.context.store.getSession(sessionId);
    if (!session)
      throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.enterSessionOperation(session);
    try {
      const sourceRun = this.context.store.getRun(runId);
      if (!sourceRun || sourceRun.sessionId !== sessionId) {
        throw new SessionApplicationError(404, "Interrupted run not found");
      }
      if (sourceRun.status !== "interrupted") {
        throw new SessionApplicationError(
          409,
          "Only interrupted runs can be resumed",
        );
      }
      if (!sourceRun.inputId) {
        throw new SessionApplicationError(
          409,
          "This interrupted run has no prompt to replay",
        );
      }
      const sourceInput = this.context.store.getInput(sourceRun.inputId);
      if (!sourceInput || sourceInput.sessionId !== sessionId) {
        throw new SessionApplicationError(
          409,
          "The original prompt is unavailable",
        );
      }

      const existingRecovery = this.context.store
        .listInputs(sessionId)
        .find(
          (candidate) =>
            isRecord(candidate.metadata.recovery) &&
            candidate.metadata.recovery.sourceRunId === sourceRun.id,
        );
      if (existingRecovery && existingRecovery.id === input.id) {
        const existingRun = this.context.store.findRunByInput(
          existingRecovery.id,
        );
        return {
          input: existingRecovery,
          ...(existingRun ? { run: existingRun } : {}),
          ...(existingRun?.status === "running"
            ? { queue_state: "running" as const }
            : {}),
          ...(existingRun?.status === "pending"
            ? { queue_state: "queued" as const }
            : {}),
          source_run: sourceRun,
        };
      }
      if (existingRecovery) {
        throw new SessionApplicationError(
          409,
          `Interrupted run already has a recovery: ${sourceRun.id}`,
        );
      }
      if (!this.hasRuntime) {
        throw new SessionApplicationError(
          409,
          "Session runtime is unavailable",
        );
      }
      if (this.context.runEngine.hasWork(sessionId)) {
        throw new SessionApplicationError(
          409,
          "Wait for the active session run before resuming interrupted work",
        );
      }

      const recovery = {
        kind: "prompt_replay",
        sourceRunId: sourceRun.id,
        sourceInputId: sourceInput.id,
      };
      const resumed = await this.context.runEngine.admitPromptAndMaybeRun(
        sessionId,
        {
          id: input.id,
          content: sourceInput.content,
          metadata: { ...(input.metadata ?? {}), recovery },
          runMetadata: { recovery },
          traceId: input.traceId,
        },
      );
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
    } finally {
      lease.release();
    }
  }

  async interruptSession(
    sessionId: string,
  ): Promise<ReturnType<SessionRunEngine["interruptSession"]>> {
    this.assertReady();
    const lane = this.context.runEngine.interruptSession(sessionId);
    const targets = [sessionId, ...this.descendantSessionIds(sessionId)];
    const childInterrupted = (
      await Promise.all(
        targets.map((target) =>
          this.context.liveChildren.interrupt(target, "Session interrupted"),
        ),
      )
    ).some(Boolean);
    return childInterrupted && !lane.interrupted
      ? { ...lane, interrupted: true }
      : lane;
  }

  async awaitRun(
    sessionId: string,
    runId: string,
  ): Promise<AwaitSessionRunResult> {
    return await this.context.runEngine.awaitRun(sessionId, runId);
  }

  async closeRuntime(sessionId: string): Promise<void> {
    this.assertReady();
    if (
      await this.context.liveChildren.interrupt(
        sessionId,
        "Session runtime closed",
      )
    )
      return;
    await this.context.agentPool.close(sessionId);
  }

  async archiveSessionTree(
    sessionId: string,
  ): Promise<ReturnType<SessionStore["archiveSession"]>> {
    this.assertReady();
    const existing = this.archivePromises.get(sessionId);
    if (existing) return await existing;
    const archive = this.archiveSessionTreeWork(sessionId).finally(() => {
      if (this.archivePromises.get(sessionId) === archive)
        this.archivePromises.delete(sessionId);
    });
    this.archivePromises.set(sessionId, archive);
    return await archive;
  }

  async deleteSessionTree(sessionId: string): Promise<string[]> {
    this.assertReady();
    const current = this.context.store.getSession(sessionId);
    if (!current)
      throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    const lease = this.context.operationGate.tryEnterBarrier(
      { kind: "session", sessionId, cwd: current.cwd },
      () => true,
    );
    if (!lease)
      throw new SessionApplicationError(
        409,
        "Session is busy with another operation",
      );
    try {
      if (current.status !== "archived" && current.status !== "closing") {
        this.context.store.beginArchive(sessionId);
      }
      const interrupted = this.context.runEngine.interruptSession(sessionId);
      const liveInterrupt = this.context.liveChildren.interrupt(
        sessionId,
        "Session deleted",
      );
      const children = this.context.store.listChildSessions(sessionId, {
        includeArchived: true,
      });
      await liveInterrupt;
      const deletedChildIds: string[] = [];
      for (const child of children)
        deletedChildIds.push(...(await this.deleteSessionTree(child.id)));
      const interruptedRunIds = [
        interrupted.activeRunId,
        ...interrupted.queuedRunIds,
      ].filter((runId): runId is string => !!runId);
      await this.context.runEngine.waitForRuns(interruptedRunIds);
      await this.context.agentPool.close(sessionId);
      return [
        ...deletedChildIds,
        ...this.context.store.deleteSessionTree(sessionId),
      ];
    } finally {
      lease.release();
    }
  }

  private async archiveSessionTreeWork(
    sessionId: string,
  ): Promise<ReturnType<SessionStore["archiveSession"]>> {
    const beforeClosing = this.context.events.checkpoint();
    const current = this.context.store.getSession(sessionId);
    if (!current)
      throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
    if (current.status === "archived") return current;
    const lease = this.context.operationGate.tryEnterBarrier(
      { kind: "session", sessionId, cwd: current.cwd },
      () => true,
    );
    if (!lease)
      throw new SessionApplicationError(
        409,
        "Session is busy with another operation",
      );
    try {
      this.context.store.beginArchive(sessionId);
      this.context.events.publishSince(beforeClosing);
      const interrupted = this.context.runEngine.interruptSession(sessionId);
      const liveInterrupt = this.context.liveChildren.interrupt(
        sessionId,
        "Session archived",
      );

      // Closing the parent first makes the descendant snapshot stable: the
      // event projector rejects child.created for closing sessions.
      const children = this.context.store.listChildSessions(sessionId);
      await liveInterrupt;
      for (const child of children) await this.archiveSessionTree(child.id);
      const interruptedRunIds = [
        interrupted.activeRunId,
        ...interrupted.queuedRunIds,
      ].filter((runId): runId is string => !!runId);
      await this.context.runEngine.waitForRuns(interruptedRunIds);
      await this.context.agentPool.close(sessionId);
      const before = this.context.events.checkpoint();
      const session = this.context.store.archiveSession(sessionId);
      this.context.events.publishSince(before);
      return session;
    } finally {
      lease.release();
    }
  }

  private enterSessionOperation(
    session: Pick<
      NonNullable<ReturnType<SessionStore["getSession"]>>,
      "id" | "cwd"
    >,
  ): DaemonOperationLease {
    try {
      return this.context.operationGate.enter({
        sessionId: session.id,
        cwd: session.cwd,
      });
    } catch (error) {
      if (error instanceof DaemonOperationUnavailableError) {
        throw new SessionApplicationError(409, error.message);
      }
      throw error;
    }
  }

  private acquireSessionMutation(
    session: Pick<
      NonNullable<ReturnType<SessionStore["getSession"]>>,
      "id" | "cwd"
    >,
    message: string,
  ): DaemonOperationLease {
    const lease = this.context.operationGate.tryEnterBarrier(
      { kind: "session", sessionId: session.id, cwd: session.cwd },
      () =>
        !this.context.liveChildren.has(session.id) &&
        !this.context.runEngine.hasWork(session.id) &&
        !this.context.agentPool.hasActiveWorkForSession(session.id),
    );
    if (!lease) throw new SessionApplicationError(409, message);
    return lease;
  }

  private warmWhenAdmitted(
    session: Pick<
      NonNullable<ReturnType<SessionStore["getSession"]>>,
      "id" | "cwd"
    >,
  ): void {
    let lease: DaemonOperationLease;
    try {
      lease = this.context.operationGate.enter({
        sessionId: session.id,
        cwd: session.cwd,
      });
    } catch (error) {
      if (error instanceof DaemonOperationUnavailableError) return;
      throw error;
    }
    void this.context.agentPool.warm(session.id).finally(() => lease.release());
  }

  private assertReady(): void {
    this.context.assertReady?.();
  }

  private descendantSessionIds(sessionId: string): string[] {
    const result: string[] = [];
    for (const child of this.context.store.listChildSessions(sessionId)) {
      result.push(child.id, ...this.descendantSessionIds(child.id));
    }
    return result;
  }
}

function mergeSessionMetadata(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing, ...patch };
  if (patch.runtime !== undefined) {
    next.runtime = {
      ...readRuntimeMetadata(existing),
      ...readRuntimeMetadata(patch),
    };
  }
  return next;
}

function forkSessionMetadata(
  existing: Record<string, unknown>,
  fork: {
    sourceSessionId: string;
    beforeMessageId?: string;
    afterMessageId?: string;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    fork: {
      ...fork,
      createdAt: Date.now(),
    },
  };
  if (isRecord(next.desktop)) {
    const desktop = { ...next.desktop };
    delete desktop.pinnedAt;
    next.desktop = desktop;
  }
  return next;
}

function copyTranscript(
  messages: ReturnType<SessionStore["listMessages"]>,
  parts: ReturnType<SessionStore["listMessageParts"]>,
): ReplaceTranscriptMessageInput[] {
  const partsByMessage = new Map<string, typeof parts>();
  for (const part of parts) {
    const group = partsByMessage.get(part.messageId) ?? [];
    group.push(part);
    partsByMessage.set(part.messageId, group);
  }
  return messages.map((message) => ({
    role: message.role,
    metadata: { ...message.metadata },
    parts: (partsByMessage.get(message.id) ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((part) => ({
        type: part.type,
        status: part.status,
        ...(part.text !== undefined ? { text: part.text } : {}),
        ...(part.toolUseId !== undefined ? { toolUseId: part.toolUseId } : {}),
        ...(part.toolName !== undefined ? { toolName: part.toolName } : {}),
        ...(part.input !== undefined ? { input: part.input } : {}),
        ...(part.output !== undefined ? { output: part.output } : {}),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
        metadata: { ...part.metadata },
      })),
  }));
}

function promptResult(
  store: SessionStore,
  input: NonNullable<ReturnType<SessionStore["getInput"]>>,
): AdmitPromptResult {
  const run = store.findRunByInput(input.id);
  return {
    input,
    ...(run ? { run } : {}),
    ...(run?.status === "running" ? { queue_state: "running" as const } : {}),
    ...(run?.status === "pending" ? { queue_state: "queued" as const } : {}),
  };
}
