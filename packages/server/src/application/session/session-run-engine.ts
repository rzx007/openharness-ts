import { randomUUID } from "node:crypto";

import type {
  AdmitPromptAttachmentInput,
  AttachmentLimits,
  ReplaceTranscriptMessageInput,
  SessionRunRecord,
} from "@openharness/protocol";
import {
  AttachmentError,
  normalizePromptAttachments,
  promptAttachmentFingerprint,
  type SessionStore,
} from "@openharness/services";

import { jsonEqual, normalizeTraceId, withoutTraceId } from "../support.js";
import {
  RunInterruptedError,
  SessionRunCoordinator,
} from "../../runtime/run-coordinator.js";
import type { SessionRunExecutor } from "./session-run-executor.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { AgentPool } from "../agent/agent-pool.js";

export type AdmitPromptInput = {
  id?: string;
  delivery?: "queue" | "steer";
  content: string;
  metadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  traceId?: string;
  attachments?: AdmitPromptAttachmentInput[];
};

export type AdmitPromptResult = {
  input: ReturnType<SessionStore["admitPrompt"]>;
  run?: ReturnType<SessionStore["createRun"]>;
  queue_state?: "running" | "queued";
};

export type AwaitSessionRunResult = {
  status: Extract<
    SessionRunRecord["status"],
    "completed" | "failed" | "interrupted"
  >;
  output: string;
  error?: string;
};

export type PromoteQueuedRunResult = {
  input: NonNullable<ReturnType<SessionStore["getInput"]>>;
  queued_run: NonNullable<ReturnType<SessionStore["getRun"]>>;
  active_run: NonNullable<ReturnType<SessionStore["getRun"]>>;
};

export interface SessionRunEngineContext {
  store: SessionStore;
  agentPool: AgentPool;
  runExecutor: Pick<SessionRunExecutor, "execute">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  attachmentLimits?: AttachmentLimits;
}

/**
 * Prompt 准入与 session lane 调度（不执行模型）。
 * 负责 admit/steer/queue、创建 run、enqueue 到 SessionRunCoordinator，
 * 以及 awaitRun / interrupt；真正跑模型交给 SessionRunExecutor。
 */
export class SessionRunEngine {
  private readonly runCoordinator = new SessionRunCoordinator();
  private readonly runPromises = new Map<string, Promise<void>>();
  private accepting = true;
  private stopPromise?: Promise<void>;
  private readonly pendingAdmissions = new Map<
    string,
    {
      sessionId: string;
      delivery: "queue" | "steer";
      content: string;
      attachmentFingerprint: string;
      metadata: Record<string, unknown>;
      promise: Promise<AdmitPromptResult>;
    }
  >();

  constructor(private readonly context: SessionRunEngineContext) {}

  activeRunId(sessionId: string): string | undefined {
    return this.runCoordinator.activeRunId(sessionId);
  }

  queuedRunIds(sessionId: string): string[] {
    return this.runCoordinator.queuedRunIds(sessionId);
  }

  hasWork(sessionId: string): boolean {
    return this.runCoordinator.hasWork(sessionId);
  }

  async promoteQueuedRun(
    sessionId: string,
    inputId: string,
    queuedRunId: string,
    expectedActiveRunId: string,
  ): Promise<PromoteQueuedRunResult | undefined> {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const input = this.context.store.getInput(inputId);
    const queuedRun = this.context.store.getRun(queuedRunId);
    if (!input || !queuedRun) return undefined;
    const promoted = this.runCoordinator.promoteQueuedRun(
      sessionId,
      queuedRunId,
      expectedActiveRunId,
      {
        id: input.id,
        content: input.content,
        delivery: "steer",
        traceId: normalizeTraceId(input.metadata.traceId),
        metadata: {
          ...input.metadata,
          promotion: {
            kind: "queued_prompt",
            queuedRunId,
            expectedActiveRunId,
          },
        },
      },
    );
    if (!promoted.promoted) return undefined;
    await promoted.delivery;

    const before = this.context.events.checkpoint();
    const promotedAt = Date.now();
    const updatedQueuedRun = this.context.store.updateRun(queuedRunId, {
      status: "interrupted",
      error: "Queued prompt was promoted into the active run",
      metadata: {
        promotion: {
          kind: "steered",
          inputId,
          queuedRunId,
          activeRunId: expectedActiveRunId,
          promotedAt,
        },
      },
    });
    this.context.events.publishSince(before);
    const activeRun = this.context.store.getRun(expectedActiveRunId);
    if (!activeRun || activeRun.sessionId !== sessionId) {
      throw new Error(
        `Promoted prompt active run was not found: ${expectedActiveRunId}`,
      );
    }
    return { input, queued_run: updatedQueuedRun, active_run: activeRun };
  }

  hasAnyActiveRuns(): boolean {
    return this.context.store
      .listSessions({ includeArchived: true })
      .some((session) => this.hasWork(session.id));
  }

  replaceTranscriptAndAdmitPrompt(
    sessionId: string,
    messages: ReplaceTranscriptMessageInput[],
    input: Omit<AdmitPromptInput, "delivery">,
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const runMetadata = { ...(input.runMetadata ?? {}), traceId };
    const before = this.context.events.checkpoint();
    const admitted = this.context.store.replaceTranscriptAndAdmitPrompt({
      transcript: { sessionId, messages },
      admission: {
        prompt: {
          id: input.id,
          sessionId,
          delivery: "queue",
          content: input.content,
          attachments: input.attachments,
          metadata,
        },
        run: { metadata: runMetadata },
      },
      createRun: this.context.agentPool.configured,
    });
    this.context.events.publishSince(before);
    if (!admitted.run) return { input: admitted.input };
    return {
      input: admitted.input,
      run: admitted.run,
      queue_state: this.enqueueRun(admitted.run, admitted.input.id),
    };
  }

  replaceLatestPrompt(
    sessionId: string,
    sourceMessageId: string,
    input: Omit<AdmitPromptInput, "delivery">,
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const before = this.context.events.checkpoint();
    const admitted = this.context.store.replaceLatestPromptWithAdmission({
      sessionId,
      sourceMessageId,
      admission: {
        prompt: {
          id: input.id,
          sessionId,
          delivery: "queue",
          content: input.content,
          attachments: input.attachments,
          metadata,
        },
        run: { metadata: { ...(input.runMetadata ?? {}), traceId } },
      },
      createRun: this.context.agentPool.configured,
    });
    this.context.events.publishSince(before);
    if (!admitted.run) return { input: admitted.input };
    return {
      input: admitted.input,
      run: admitted.run,
      queue_state: this.enqueueRun(admitted.run, admitted.input.id),
    };
  }

  replayInput(
    inputId: string,
    input: { id?: string; metadata?: Record<string, unknown>; traceId?: string },
  ): AdmitPromptResult {
    if (!this.accepting) throw new Error("Session run engine is stopping");
    const sourceInput = this.context.store.getInput(inputId);
    if (!sourceInput) throw new Error(`Session input not found: ${inputId}`);
    const existing = input.id ? this.context.store.getRun(input.id) : undefined;
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const before = this.context.events.checkpoint();
    const run = this.context.store.createReplayRun(inputId, {
      id: input.id,
      metadata: { ...(input.metadata ?? {}), traceId },
    });
    this.context.events.publishSince(before);
    if (existing || run.status !== "pending") {
      return {
        input: sourceInput,
        run,
        ...(run.status === "running" ? { queue_state: "running" } : {}),
        ...(run.status === "pending" ? { queue_state: "queued" } : {}),
      };
    }
    return {
      input: sourceInput,
      run,
      queue_state: this.enqueueRun(run, sourceInput.id),
    };
  }

  hasActiveRunsForCwd(cwd: string): boolean {
    return this.context.store
      .listSessions({ cwd, includeArchived: true })
      .some((session) => this.hasWork(session.id));
  }

  async stopAndDrain(reason = "Daemon shutting down"): Promise<void> {
    if (this.stopPromise) return await this.stopPromise;
    this.accepting = false;
    const stopping = (async () => {
      const runIds: string[] = [];
      for (const sessionId of this.runCoordinator.sessionIds()) {
        const interrupted = this.interruptSession(sessionId, reason);
        if (interrupted.activeRunId) runIds.push(interrupted.activeRunId);
        runIds.push(...interrupted.queuedRunIds);
      }
      await this.waitForRuns(runIds);
    })();
    this.stopPromise = stopping;
    await stopping;
  }

  async awaitRun(
    sessionId: string,
    runId: string,
  ): Promise<AwaitSessionRunResult> {
    const initial = this.context.store.getRun(runId);
    if (!initial || initial.sessionId !== sessionId)
      throw new Error(`Session run not found: ${runId}`);
    if (initial.status === "pending" || initial.status === "running") {
      await this.runPromises.get(runId);
    }
    const run = this.context.store.getRun(runId);
    if (!run || run.sessionId !== sessionId)
      throw new Error(`Session run not found: ${runId}`);
    if (run.status === "pending" || run.status === "running") {
      throw new Error(`Session run is still active: ${runId}`);
    }
    const output = this.context.store
      .listMessages(sessionId)
      .filter(
        (message) => message.runId === runId && message.role === "assistant",
      )
      .flatMap((message) =>
        this.context.store.listMessageParts(sessionId, {
          messageId: message.id,
        }),
      )
      .map((part) => {
        if (part.text) return part.text;
        if (part.output == null) return "";
        return typeof part.output === "string"
          ? part.output
          : JSON.stringify(part.output);
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
    await Promise.all(
      runIds
        .map((runId) => this.runPromises.get(runId))
        .filter((promise): promise is Promise<void> => promise !== undefined),
    );
  }

  admitPromptAndMaybeRun(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    if (!this.accepting)
      return Promise.reject(new Error("Session run engine is stopping"));
    if (!input.id) return this.admitPrompt(sessionId, input);
    const attachments = normalizePromptAttachments(input.attachments);
    const delivery =
      attachments.length > 0 && input.delivery === "steer"
        ? "queue"
        : (input.delivery ?? "queue");
    const attachmentFingerprint = promptAttachmentFingerprint(attachments);
    const metadata = withoutTraceId(input.metadata ?? {});
    const pending = this.pendingAdmissions.get(input.id);
    if (pending) {
      if (
        pending.sessionId !== sessionId ||
        pending.delivery !== delivery ||
        pending.content !== input.content ||
        pending.attachmentFingerprint !== attachmentFingerprint ||
        !jsonEqual(pending.metadata, metadata)
      ) {
        throw new AttachmentError(
          "prompt_id_conflict",
          `Prompt id is already used: ${input.id}`,
        );
      }
      return pending.promise;
    }
    const promise = this.admitPrompt(sessionId, input).finally(() => {
      if (this.pendingAdmissions.get(input.id!)?.promise === promise) {
        this.pendingAdmissions.delete(input.id!);
      }
    });
    this.pendingAdmissions.set(input.id, {
      sessionId,
      delivery,
      content: input.content,
      attachmentFingerprint,
      metadata,
      promise,
    });
    return promise;
  }

  private async admitPrompt(
    sessionId: string,
    input: AdmitPromptInput,
  ): Promise<AdmitPromptResult> {
    const attachments = normalizePromptAttachments(input.attachments);
    const delivery =
      attachments.length > 0 && input.delivery === "steer"
        ? "queue"
        : (input.delivery ?? "queue");
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(input.metadata?.traceId) ??
      randomUUID();
    const metadata = { ...(input.metadata ?? {}), traceId };
    const runMetadata = { ...(input.runMetadata ?? {}), traceId };
    const existingInput = input.id
      ? this.context.store.getInput(input.id)
      : undefined;
    if (existingInput) {
      if (
        existingInput.sessionId !== sessionId ||
        existingInput.content !== input.content ||
        existingInput.delivery !== delivery ||
        promptAttachmentFingerprint(
          existingInput.attachments.map((reference) => ({
            assetId: reference.assetId,
            intent: reference.intent,
            ...(typeof reference.metadata.requestedDisplayName === "string"
              ? { displayName: reference.metadata.requestedDisplayName }
              : {}),
          })),
        ) !== promptAttachmentFingerprint(attachments) ||
        !jsonEqual(
          withoutTraceId(existingInput.metadata),
          withoutTraceId(metadata),
        )
      ) {
        throw new AttachmentError(
          "prompt_id_conflict",
          `Prompt id is already used: ${input.id}`,
        );
      }
      const existingRun = this.context.store.findRunByInput(existingInput.id);
      if (!existingRun && this.context.agentPool.configured) {
        const before = this.context.events.checkpoint();
        const recovered = this.context.store.createRun({
          sessionId,
          inputId: existingInput.id,
          metadata: { ...runMetadata, recoveredAdmission: true },
        });
        this.context.events.publishSince(before);
        return {
          input: existingInput,
          run: recovered,
          queue_state: this.enqueueRun(recovered, existingInput.id),
        };
      }
      return {
        input: existingInput,
        ...(existingRun ? { run: existingRun } : {}),
        ...(existingRun?.status === "running"
          ? { queue_state: "running" as const }
          : {}),
        ...(existingRun?.status === "pending"
          ? { queue_state: "queued" as const }
          : {}),
      };
    }

    const before = this.context.events.checkpoint();
    if (delivery === "queue" && this.context.agentPool.configured) {
      const admission = {
        prompt: {
          id: input.id,
          sessionId,
          delivery,
          content: input.content,
          attachments,
          metadata,
        },
        run: { metadata: runMetadata },
      };
      const admitted = this.context.attachmentLimits
        ? this.context.store.admitPromptWithRun(admission, {
            attachmentLimits: this.context.attachmentLimits,
          })
        : this.context.store.admitPromptWithRun(admission);
      this.context.events.publishSince(before);
      return {
        input: admitted.input,
        run: admitted.run,
        queue_state: this.enqueueRun(admitted.run, admitted.input.id),
      };
    }

    const admission = {
      id: input.id,
      sessionId,
      delivery,
      content: input.content,
      attachments,
      metadata,
    };
    const admitted = this.context.attachmentLimits
      ? this.context.store.admitPrompt(admission, {
          attachmentLimits: this.context.attachmentLimits,
        })
      : this.context.store.admitPrompt(admission);

    if (delivery === "steer" && this.context.agentPool.configured) {
      const steered = this.runCoordinator.steer(sessionId, {
        id: admitted.id,
        content: admitted.content,
        delivery: "steer",
        traceId,
        metadata: admitted.metadata,
      });
      if (steered.merged && steered.activeRunId) {
        this.context.events.publishSince(before);
        let delivered: Awaited<typeof steered.delivery>;
        try {
          delivered = await steered.delivery;
        } catch (error) {
          this.terminalizeUndeliveredSteer(
            sessionId,
            admitted.id,
            traceId,
            error,
          );
          throw error;
        }
        const activeRun = this.context.store.getRun(delivered.runId);
        if (!activeRun || activeRun.sessionId !== sessionId) {
          throw new Error(
            `Steered input run was not found: ${delivered.runId}`,
          );
        }
        return {
          input: admitted,
          run: activeRun,
          ...(activeRun.status === "running"
            ? { queue_state: "running" as const }
            : {}),
          ...(activeRun.status === "pending"
            ? { queue_state: "queued" as const }
            : {}),
        };
      }
    }

    const run = this.context.agentPool.configured
      ? this.context.store.createRun({
          sessionId,
          inputId: admitted.id,
          metadata: runMetadata,
        })
      : undefined;
    this.context.events.publishSince(before);
    let queueState: "running" | "queued" | undefined;
    if (run) {
      queueState = this.enqueueRun(run, admitted.id);
    }
    return {
      input: admitted,
      ...(run ? { run, queue_state: queueState } : {}),
    };
  }

  interruptSession(
    sessionId: string,
    reason?: string,
  ): ReturnType<SessionRunCoordinator["interrupt"]> {
    const before = this.context.events.checkpoint();
    const result = this.runCoordinator.interrupt(sessionId, reason);
    if (result.interrupted) {
      this.context.store.transaction(() => {
        for (const runId of result.queuedRunIds) {
          this.context.store.updateRun(runId, {
            status: "interrupted",
            error: reason ?? "Queued run interrupted",
          });
        }
        this.context.store.appendEvent({
          type: "session.run.interrupt_requested",
          sessionId,
          payload: {
            runId: result.activeRunId,
            queuedRunIds: result.queuedRunIds,
            reason: reason ?? "Run interrupted",
          },
        });
      });
      this.context.events.publishSince(before);
    }
    return result;
  }

  interruptRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): ReturnType<SessionRunCoordinator["interruptRun"]> {
    const before = this.context.events.checkpoint();
    const result = this.runCoordinator.interruptRun(sessionId, runId, reason);
    if (result.interrupted) {
      this.context.store.transaction(() => {
        for (const queuedRunId of result.queuedRunIds) {
          this.context.store.updateRun(queuedRunId, {
            status: "interrupted",
            error: reason ?? "Queued run interrupted",
          });
        }
        this.context.store.appendEvent({
          type: "session.run.interrupt_requested",
          sessionId,
          payload: {
            runId,
            queuedRunIds: result.queuedRunIds,
            reason: reason ?? "Run interrupted",
            scoped: true,
          },
        });
      });
      this.context.events.publishSince(before);
    }
    return result;
  }

  interruptQueuedRun(
    sessionId: string,
    runId: string,
    reason?: string,
  ): ReturnType<SessionRunCoordinator["interruptQueuedRun"]> {
    const before = this.context.events.checkpoint();
    const result = this.runCoordinator.interruptQueuedRun(
      sessionId,
      runId,
      reason,
    );
    if (result.queuedRunIds.includes(runId)) {
      this.context.store.transaction(() => {
        this.context.store.updateRun(runId, {
          status: "interrupted",
          error: reason ?? "Queued run interrupted",
        });
        this.context.store.appendEvent({
          type: "session.run.interrupt_requested",
          sessionId,
          payload: {
            runId,
            queuedRunIds: [runId],
            reason: reason ?? "Queued run interrupted",
            scoped: true,
            queuedOnly: true,
          },
        });
      });
      this.context.events.publishSince(before);
    }
    return result;
  }

  private enqueueRun(
    run: SessionRunRecord,
    inputId: string,
  ): "running" | "queued" {
    const enqueued = this.runCoordinator.enqueue({
      sessionId: run.sessionId,
      runId: run.id,
      work: (workContext) =>
        this.context.runExecutor.execute(
          {
            sessionId: run.sessionId,
            inputId,
            runId: run.id,
          },
          workContext,
        ),
      onSteerRejected: (input) =>
        this.enqueueRejectedSteer(run.sessionId, input),
    });
    const tracked = enqueued.promise
      .catch(() => {
        // The persisted run state is updated by SessionRunExecutor or interrupt handling.
      })
      .finally(() => {
        if (this.runPromises.get(run.id) === tracked)
          this.runPromises.delete(run.id);
      });
    this.runPromises.set(run.id, tracked);
    return enqueued.state;
  }

  private enqueueRejectedSteer(
    sessionId: string,
    input: { id?: string; traceId?: string },
  ): string {
    if (!input.id)
      throw new Error("Rejected steer is missing its durable input id");
    const admitted = this.context.store.getInput(input.id);
    if (!admitted || admitted.sessionId !== sessionId) {
      throw new Error(`Rejected steer input was not found: ${input.id}`);
    }
    const existing = this.context.store.findRunByInput(admitted.id);
    if (existing?.inputId === admitted.id) return existing.id;
    const before = this.context.events.checkpoint();
    const traceId =
      normalizeTraceId(input.traceId) ??
      normalizeTraceId(admitted.metadata.traceId) ??
      randomUUID();
    const run = this.context.store.createRun({
      sessionId,
      inputId: admitted.id,
      metadata: { traceId, recoveredFromSteer: true },
    });
    this.context.events.publishSince(before);
    this.enqueueRun(run, admitted.id);
    return run.id;
  }

  private terminalizeUndeliveredSteer(
    sessionId: string,
    inputId: string,
    traceId: string,
    error: unknown,
  ): void {
    if (this.context.store.findRunByInput(inputId)) return;
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = error instanceof RunInterruptedError;
    const before = this.context.events.checkpoint();
    this.context.store.transaction(() => {
      const created = this.context.store.createRun({
        sessionId,
        inputId,
        metadata: { traceId, steerDeliveryFailed: true },
      });
      this.context.store.appendEvent({
        type: interrupted ? "session.run.interrupted" : "session.run.error",
        sessionId,
        payload: {
          runId: created.id,
          traceId,
          error: message,
          steerDeliveryFailure: true,
        },
      });
      this.context.store.updateRun(created.id, {
        status: interrupted ? "interrupted" : "failed",
        error: message,
      });
    });
    this.context.events.publishSince(before);
  }
}
