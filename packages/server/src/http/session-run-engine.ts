import { randomUUID } from "node:crypto";

import type { SessionEventRecord, SessionStore } from "@openharness/services";

import {
  jsonEqual,
  normalizeTraceId,
  withoutTraceId,
} from "./support.js";
import type { StorePermissionBroker } from "../permission-broker.js";
import { RunInterruptedError, SessionRunCoordinator, type SessionRunWorkContext } from "../run-coordinator.js";
import type { ChildSessionHost, SessionRuntime, SessionRuntimeFactory } from "../runtime.js";
import type { ObservabilityEvent } from "../observability.js";
import type { SessionRunRenderer } from "./run-renderer.js";
import type { SessionTaskBridgeManager } from "./session-task-bridge.js";

export type AdmitPromptInput = {
  id?: string;
  delivery?: "queue" | "steer";
  content: string;
  metadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  traceId?: string;
};

export type AdmitPromptResult = {
  input: ReturnType<SessionStore["admitPrompt"]>;
  run?: ReturnType<SessionStore["createRun"]>;
  queue_state?: "running" | "queued";
};

export interface SessionRunEngineContext {
  store: SessionStore;
  runtimeFactory?: SessionRuntimeFactory;
  childSessionHost: ChildSessionHost;
  permissionBroker: Pick<StorePermissionBroker, "ask">;
  runRenderer: SessionRunRenderer;
  sessionTaskBridgeManager: SessionTaskBridgeManager;
  latestEventSeq(): number;
  broadcastSince(seq: number): void;
  broadcastEvent(event: SessionEventRecord): void;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}

export class SessionRunEngine {
  private readonly runCoordinator = new SessionRunCoordinator();
  private readonly runPromises = new Map<string, Promise<void>>();
  private readonly runtimes = new Map<string, Promise<SessionRuntime>>();

  constructor(private readonly context: SessionRunEngineContext) {}

  get warmRuntimeCount(): number {
    return this.runtimes.size;
  }

  activeRunId(sessionId: string): string | undefined {
    return this.runCoordinator.activeRunId(sessionId);
  }

  queuedRunIds(sessionId: string): string[] {
    return this.runCoordinator.queuedRunIds(sessionId);
  }

  hasWork(sessionId: string): boolean {
    return this.runCoordinator.hasWork(sessionId);
  }

  hasAnyActiveRuns(): boolean {
    return this.context.store
      .listSessions({ includeArchived: true })
      .some((session) => this.hasWork(session.id));
  }

  hasActiveRunsForCwd(cwd: string): boolean {
    return this.context.store
      .listSessions({ cwd, includeArchived: true })
      .some((session) => this.hasWork(session.id));
  }

  async closeRuntimesForCwd(cwd: string): Promise<void> {
    const sessions = this.context.store.listSessions({ cwd, includeArchived: true });
    await Promise.all(sessions.map((session) => this.closeRuntime(session.id)));
  }

  async awaitRun(sessionId: string, runId: string): ReturnType<ChildSessionHost["awaitRun"]> {
    const initial = this.context.store.getRun(runId);
    if (!initial || initial.sessionId !== sessionId) throw new Error(`Session run not found: ${runId}`);
    if (initial.status === "pending" || initial.status === "running") {
      await this.runPromises.get(runId);
    }
    const run = this.context.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`Session run not found: ${runId}`);
    if (run.status === "pending" || run.status === "running") {
      throw new Error(`Session run is still active: ${runId}`);
    }
    const output = this.context.store.listMessages(sessionId)
      .filter((message) => message.runId === runId && message.role === "assistant")
      .flatMap((message) => this.context.store.listMessageParts(sessionId, { messageId: message.id }))
      .map((part) => {
        if (part.text) return part.text;
        if (part.output == null) return "";
        return typeof part.output === "string" ? part.output : JSON.stringify(part.output);
      })
      .filter(Boolean)
      .join("\n");
    return {
      status: run.status,
      output,
      ...(run.error ? { error: run.error } : {}),
    };
  }

  async waitForRuns(runIds: string[]): Promise<void> {
    await Promise.all(runIds
      .map((runId) => this.runPromises.get(runId))
      .filter((promise): promise is Promise<void> => promise !== undefined));
  }

  admitPromptAndMaybeRun(sessionId: string, input: AdmitPromptInput): AdmitPromptResult {
    const delivery = input.delivery ?? "queue";
    const traceId = normalizeTraceId(input.traceId) ?? normalizeTraceId(input.metadata?.traceId) ?? randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const runMetadata = { ...(input.runMetadata ?? {}), traceId };
    const existingInput = input.id ? this.context.store.getInput(input.id) : undefined;
    if (existingInput) {
      if (
        existingInput.sessionId !== sessionId ||
        existingInput.content !== input.content ||
        existingInput.delivery !== delivery ||
        !jsonEqual(withoutTraceId(existingInput.metadata), withoutTraceId(metadata))
      ) {
        throw new Error(`Prompt id is already used: ${input.id}`);
      }
      const existingRun = this.context.store.findRunByInput(existingInput.id);
      return {
        input: existingInput,
        ...(existingRun ? { run: existingRun } : {}),
        ...(existingRun?.status === "running" ? { queue_state: "running" as const } : {}),
        ...(existingRun?.status === "pending" ? { queue_state: "queued" as const } : {}),
      };
    }

    const before = this.context.latestEventSeq();
    const admitted = this.context.store.admitPrompt({
      id: input.id,
      sessionId,
      delivery,
      content: input.content,
      metadata,
    });

    if (delivery === "steer" && this.context.runtimeFactory) {
      const activeRunId = this.runCoordinator.activeRunId(sessionId);
      if (activeRunId) {
        this.context.broadcastSince(before);
        this.runCoordinator.mergeWake(sessionId);
        const activeRun = this.context.store.getRun(activeRunId);
        return {
          input: admitted,
          ...(activeRun ? { run: activeRun, queue_state: "running" as const } : {}),
        };
      }
    }

    const run = this.context.runtimeFactory
      ? this.context.store.createRun({ sessionId, inputId: admitted.id, metadata: runMetadata })
      : undefined;
    this.context.broadcastSince(before);
    let queueState: "running" | "queued" | undefined;
    if (run) {
      const enqueued = this.runCoordinator.enqueue({
        sessionId,
        runId: run.id,
        work: (workContext) => this.executeRun(sessionId, admitted.id, run.id, workContext),
      });
      queueState = enqueued.state;
      const tracked = enqueued.promise.catch(() => {
        // The persisted run state is updated by executeRun or interrupt handling.
      }).finally(() => {
        if (this.runPromises.get(run.id) === tracked) this.runPromises.delete(run.id);
      });
      this.runPromises.set(run.id, tracked);
    }
    return { input: admitted, ...(run ? { run, queue_state: queueState } : {}) };
  }

  interruptSession(sessionId: string): ReturnType<SessionRunCoordinator["interrupt"]> {
    const before = this.context.latestEventSeq();
    const result = this.runCoordinator.interrupt(sessionId);
    if (result.interrupted) {
      for (const runId of result.queuedRunIds) {
        this.context.store.updateRun(runId, { status: "interrupted", error: "Queued run interrupted" });
      }
      this.context.store.appendEvent({
        type: "session.run.interrupt_requested",
        sessionId,
        payload: { runId: result.activeRunId, queuedRunIds: result.queuedRunIds },
      });
      this.context.broadcastSince(before);
    }
    return result;
  }

  async warmRuntime(sessionId: string): Promise<void> {
    if (!this.context.runtimeFactory || this.runtimes.has(sessionId)) return;
    const session = this.context.store.getSession(sessionId);
    if (!session || session.status === "archived") return;
    const history = this.context.store.listMessages(sessionId);
    const parts = this.context.store.listMessageParts(sessionId);
    await this.getOrCreateRuntime(session, history, parts).catch(() => {});
  }

  async runtimeForSession(sessionId: string): Promise<SessionRuntime | undefined> {
    return this.runtimes.get(sessionId) ? await this.runtimes.get(sessionId)! : undefined;
  }

  async closeRuntime(sessionId: string): Promise<void> {
    const runtimePromise = this.runtimes.get(sessionId);
    if (!runtimePromise) return;
    this.runtimes.delete(sessionId);
    try {
      const runtime = await runtimePromise;
      await runtime.close();
    } catch {
      // Runtime may have failed while being created; nothing else to close.
    }
  }

  async closeAllRuntimes(): Promise<void> {
    const sessionIds = [...this.runtimes.keys()];
    await Promise.all(sessionIds.map((sessionId) => this.closeRuntime(sessionId)));
  }

  private async executeRun(
    sessionId: string,
    inputId: string,
    runId: string,
    workContext: SessionRunWorkContext,
  ): Promise<void> {
    if (!this.context.runtimeFactory) return;
    let before = this.context.latestEventSeq();
    try {
      const session = this.context.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const history = this.context.store.listMessages(sessionId);
      const parts = this.context.store.listMessageParts(sessionId);
      const admitted = this.context.store.getInput(inputId);
      if (!admitted) throw new Error(`Session input not found: ${inputId}`);
      const traceId = this.context.traceIdForRun(runId);

      this.context.store.updateRun(runId, { status: "running" });
      this.context.log({ level: "info", event: "session.run.started", traceId, sessionId, runId });
      const renderState = this.context.runRenderer.createState(sessionId, inputId, runId, admitted.content);
      this.context.broadcastSince(before);

      const drainSteeredInputs = () => {
        const pending = this.context.store.listUnboundInputs(sessionId);
        if (pending.length === 0) return pending;
        const eventBefore = this.context.latestEventSeq();
        this.context.runRenderer.drainSteeredInputs(renderState, pending);
        this.context.broadcastSince(eventBefore);
        return pending;
      };

      const runtime = await this.getOrCreateRuntime(session, history, parts);
      await runtime.runPrompt(
        {
          session,
          input: admitted,
          runId,
          history,
          parts,
          signal: workContext.signal,
          wakeCount: workContext.wakeCount,
          drainSteeredInputs,
        },
        {
          onEvent: (event) => {
            const eventBefore = this.context.latestEventSeq();
            this.context.store.appendEvent({
              type: event.type,
              sessionId,
              payload: event.payload,
            });
            this.context.broadcastSince(eventBefore);
          },
          onStreamEvent: (event) => {
            const canDirectBroadcast =
              event.type === "text_delta" && this.context.runRenderer.hasActiveTextPart(renderState);
            const eventBefore = canDirectBroadcast ? undefined : this.context.latestEventSeq();
            const applied = this.context.runRenderer.applyStreamEvent(renderState, event);
            if (event.type === "tool_use_start") {
              this.context.log({
                level: "info",
                event: "session.tool.started",
                traceId,
                sessionId,
                runId,
                toolName: event.toolUse.name,
              });
            } else if (event.type === "tool_use_end") {
              this.context.log({
                level: event.result.isError ? "warn" : "info",
                event: "session.tool.completed",
                traceId,
                sessionId,
                runId,
                toolName: applied.completedToolName,
                ...(event.result.isError ? { error: "tool returned an error" } : {}),
              });
            }
            if (canDirectBroadcast && applied.liveEvent) {
              this.context.broadcastEvent(applied.liveEvent);
            } else if (eventBefore !== undefined) {
              this.context.broadcastSince(eventBefore);
            }
          },
          askPermission: (request) =>
            this.context.permissionBroker.ask({
              sessionId,
              runId,
              traceId,
              toolName: request.toolName,
              reason: request.reason,
              input: request.input,
              signal: workContext.signal,
            }),
        },
      );

      before = this.context.latestEventSeq();
      this.context.runRenderer.completeActiveTextPart(renderState, "completed");
      this.context.store.updateRun(runId, { status: workContext.signal.aborted ? "interrupted" : "completed" });
      this.context.log({
        level: workContext.signal.aborted ? "warn" : "info",
        event: workContext.signal.aborted ? "session.run.interrupted" : "session.run.completed",
        traceId,
        sessionId,
        runId,
      });
      this.context.broadcastSince(before);
    } catch (error) {
      await this.closeRuntime(sessionId);
      before = this.context.latestEventSeq();
      const message = error instanceof Error ? error.message : String(error);
      const traceId = this.context.traceIdForRun(runId);
      if (error instanceof RunInterruptedError || workContext.signal.aborted) {
        this.context.store.appendEvent({
          type: "session.run.interrupted",
          sessionId,
          payload: { runId, traceId, error: message },
        });
        this.context.store.updateRun(runId, { status: "interrupted", error: message });
        this.context.log({ level: "warn", event: "session.run.interrupted", traceId, sessionId, runId, error: message });
      } else {
        this.context.store.appendEvent({
          type: "session.run.error",
          sessionId,
          payload: { runId, traceId, error: message },
        });
        this.context.store.updateRun(runId, { status: "failed", error: message });
        this.context.log({ level: "error", event: "session.run.failed", traceId, sessionId, runId, error: message });
      }
      this.context.broadcastSince(before);
    }
  }

  private async getOrCreateRuntime(
    session: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["session"],
    history: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["history"],
    parts: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["parts"],
  ): Promise<SessionRuntime> {
    if (!this.context.runtimeFactory) throw new Error("Runtime factory is not configured");
    const existing = this.runtimes.get(session.id);
    if (existing) return await existing;

    const promise = this.context.runtimeFactory.createRuntime({
      session,
      history,
      parts,
      childSessionHost: this.context.childSessionHost,
      sessionTaskBridge: this.context.sessionTaskBridgeManager.createBridge(session),
    }).catch((error) => {
      if (this.runtimes.get(session.id) === promise) this.runtimes.delete(session.id);
      throw error;
    });
    this.runtimes.set(session.id, promise);
    return await promise;
  }
}
