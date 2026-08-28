import type { StreamEvent } from "@openharness/core";
import type { AssistantMessagePhase } from "@openharness/core";
import type { SessionStore } from "@openharness/services";
import type {
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartStatus,
} from "@openharness/protocol";

type ActiveToolPart = {
  partId: string;
  messageId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ActiveTranscriptProjectionState = {
  sessionId: string;
  runId: string;
  inputId: string;
  assistantMessageId?: string;
  assistantTurnCompleted: boolean;
  activeTextPartId?: string;
  activeTextPhase?: AssistantMessagePhase;
  toolParts: Map<string, ActiveToolPart>;
};

export type AppliedTranscriptStreamEvent = {
  liveEvent?: SessionEventRecord;
  completedToolName?: string;
};

/**
 * Transcript projection sink for one run.
 *
 * It is the only place that knows how runtime StreamEvents become durable
 * messages, text parts, tool parts, and part-delta events.
 */
export class SessionTranscriptProjection {
  constructor(
    private readonly store: Pick<
      SessionStore,
      "appendMessagePartDelta" | "createMessage" | "listMessageParts" | "listMessages" | "updateRun" | "upsertMessagePart"
    >,
  ) {}

  beginRun(
    sessionId: string,
    inputId: string,
    runId: string,
    input: SessionInputRecord,
  ): ActiveTranscriptProjectionState {
    const userMessage = this.store.createMessage({
      sessionId,
      role: "user",
      runId,
      inputId,
    });
    this.projectUserInput(userMessage.id, input);
    return {
      sessionId,
      runId,
      inputId,
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
  }

  projectSteeredInputs(state: ActiveTranscriptProjectionState, pending: SessionInputRecord[]): void {
    this.completeOpenTextPart(state, "completed");
    delete state.assistantMessageId;
    state.assistantTurnCompleted = true;
    for (const steered of pending) {
      if (this.store.listMessages(state.sessionId).some((message) => message.inputId === steered.id)) continue;
      const userMessage = this.store.createMessage({
        sessionId: state.sessionId,
        role: "user",
        runId: state.runId,
        inputId: steered.id,
      });
      this.projectUserInput(userMessage.id, steered);
    }
  }

  hasOpenTextPart(state: ActiveTranscriptProjectionState): boolean {
    return Boolean(state.activeTextPartId);
  }

  projectStreamEvent(
    state: ActiveTranscriptProjectionState,
    event: StreamEvent,
  ): AppliedTranscriptStreamEvent {
    switch (event.type) {
      case "text_delta": {
        const messageId = this.ensureAssistantMessage(state, true);
        if (!state.activeTextPartId) {
          const part = this.store.upsertMessagePart({
            sessionId: state.sessionId,
            messageId,
            type: "text",
            status: "running",
            text: "",
            ...(event.phase ? { metadata: { phase: event.phase } } : {}),
          });
          state.activeTextPartId = part.id;
          state.activeTextPhase = event.phase;
        }
        return {
          liveEvent: this.store.appendMessagePartDelta({
            sessionId: state.sessionId,
            messageId,
            partId: state.activeTextPartId,
            field: "text",
            delta: event.delta,
          }),
        };
      }
      case "tool_use_start": {
        this.completeOpenTextPart(state, "completed", "commentary");
        const messageId = this.ensureAssistantMessage(state, true);
        const part = this.store.upsertMessagePart({
          id: event.toolUse.id,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: "running",
          toolUseId: event.toolUse.id,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
          metadata: {
            toolCallId: event.toolUse.id,
            toolAttemptId: `tool_attempt_${event.toolUse.id}_1`,
            outcome: "pending",
          },
        });
        state.toolParts.set(event.toolUse.id, {
          partId: part.id,
          messageId,
          toolName: event.toolUse.name,
          input: event.toolUse.input,
        });
        return {};
      }
      case "tool_use_end": {
        const active = state.toolParts.get(event.toolUseId);
        const messageId = active?.messageId ?? this.ensureAssistantMessage(state);
        this.store.upsertMessagePart({
          id: active?.partId ?? event.toolUseId,
          sessionId: state.sessionId,
          messageId,
          type: "tool",
          status: event.result.isError ? "failed" : "completed",
          toolUseId: event.toolUseId,
          ...(active?.toolName ? { toolName: active.toolName } : {}),
          ...(active?.input ? { input: active.input } : {}),
          output: event.result,
          isError: event.result.isError === true,
          metadata: {
            toolCallId: event.toolUseId,
            toolAttemptId: event.result.toolAttemptId ?? `tool_attempt_${event.toolUseId}_1`,
            outcome: event.result.isError ? "failed" : "completed",
            ...(event.result.failureKind ? { failureKind: event.result.failureKind } : {}),
          },
        });
        state.toolParts.delete(event.toolUseId);
        return { completedToolName: active?.toolName };
      }
      case "usage": {
        this.store.updateRun(state.runId, { metadata: { usage: event.usage } });
        return {};
      }
      case "complete": {
        this.completeOpenTextPart(
          state,
          "completed",
          state.activeTextPhase ?? "final_answer",
        );
        state.assistantTurnCompleted = true;
        this.store.updateRun(state.runId, { metadata: { stopReason: event.stopReason } });
        return {};
      }
      case "error": {
        const messageId = this.ensureAssistantMessage(state, true);
        this.completeOpenTextPart(state, "failed");
        this.store.upsertMessagePart({
          sessionId: state.sessionId,
          messageId,
          type: "error",
          status: "failed",
          text: event.error.message,
        });
        return {};
      }
    }
  }

  completeOpenTextPart(
    state: ActiveTranscriptProjectionState,
    status: Extract<SessionMessagePartStatus, "completed" | "failed" | "interrupted">,
    phase?: AssistantMessagePhase,
  ): void {
    if (!state.assistantMessageId || !state.activeTextPartId) return;
    this.store.upsertMessagePart({
      id: state.activeTextPartId,
      sessionId: state.sessionId,
      messageId: state.assistantMessageId,
      type: "text",
      status,
      ...(phase ? { metadata: { phase } } : {}),
    });
    delete state.activeTextPartId;
    delete state.activeTextPhase;
  }

  /** Closes parts left running when event delivery fails before terminal events are projected. */
  finalizeRunParts(
    sessionId: string,
    runId: string,
    status: Extract<SessionMessagePartStatus, "failed" | "interrupted">,
  ): void {
    const messageIds = new Set(
      this.store
        .listMessages(sessionId)
        .filter((message) => message.runId === runId)
        .map((message) => message.id),
    );
    for (const part of this.store.listMessageParts(sessionId)) {
      if (!messageIds.has(part.messageId) || part.status !== "running") continue;
      this.store.upsertMessagePart({
        id: part.id,
        sessionId,
        messageId: part.messageId,
        type: part.type,
        status,
        ...(part.type === "tool" ? {
          metadata: {
            ...part.metadata,
            outcome: status,
            failureKind: status === "interrupted" ? "interrupted" : "unknown_outcome",
            ...(status === "failed" ? { outcomeWarning: "Tool may already have executed" } : {}),
          },
        } : {}),
      });
    }
  }

  private ensureAssistantMessage(state: ActiveTranscriptProjectionState, startTurn = false): string {
    if (startTurn && state.assistantTurnCompleted) {
      delete state.assistantMessageId;
      state.assistantTurnCompleted = false;
    }
    if (state.assistantMessageId) return state.assistantMessageId;
    const message = this.store.createMessage({
      sessionId: state.sessionId,
      role: "assistant",
      runId: state.runId,
    });
    state.assistantMessageId = message.id;
    return message.id;
  }

  private projectUserInput(messageId: string, input: SessionInputRecord): void {
    if (input.content.trim().length > 0) {
      this.store.upsertMessagePart({
        sessionId: input.sessionId,
        messageId,
        type: "text",
        status: "completed",
        text: input.content,
      });
    }
    for (const attachment of [...input.attachments].sort(
      (a, b) => a.seq - b.seq,
    )) {
      this.store.upsertMessagePart({
        sessionId: input.sessionId,
        messageId,
        type: "attachment",
        status: "completed",
        assetId: attachment.assetId,
        intent: attachment.intent,
        displayName: attachment.displayName,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        metadata: { inputAttachmentId: attachment.id },
      });
    }
  }
}
