import type { StreamEvent } from "@openharness/core";
import type {
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartStatus,
  SessionStore,
} from "@openharness/services";

type ActiveToolPart = {
  partId: string;
  messageId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ActiveRunRenderState = {
  sessionId: string;
  runId: string;
  inputId: string;
  assistantMessageId?: string;
  assistantTurnCompleted: boolean;
  activeTextPartId?: string;
  toolParts: Map<string, ActiveToolPart>;
};

export type AppliedStreamEvent = {
  liveEvent?: SessionEventRecord;
  completedToolName?: string;
};

export class SessionRunRenderer {
  constructor(
    private readonly store: Pick<
      SessionStore,
      "appendMessagePartDelta" | "createMessage" | "updateRun" | "upsertMessagePart"
    >,
  ) {}

  createState(
    sessionId: string,
    inputId: string,
    runId: string,
    content: string,
  ): ActiveRunRenderState {
    const userMessage = this.store.createMessage({
      sessionId,
      role: "user",
      runId,
      inputId,
    });
    this.store.upsertMessagePart({
      sessionId,
      messageId: userMessage.id,
      type: "text",
      status: "completed",
      text: content,
    });
    return {
      sessionId,
      runId,
      inputId,
      assistantTurnCompleted: false,
      toolParts: new Map(),
    };
  }

  drainSteeredInputs(state: ActiveRunRenderState, pending: SessionInputRecord[]): void {
    this.completeActiveTextPart(state, "completed");
    delete state.assistantMessageId;
    state.assistantTurnCompleted = true;
    for (const steered of pending) {
      const userMessage = this.store.createMessage({
        sessionId: state.sessionId,
        role: "user",
        runId: state.runId,
        inputId: steered.id,
      });
      this.store.upsertMessagePart({
        sessionId: state.sessionId,
        messageId: userMessage.id,
        type: "text",
        status: "completed",
        text: steered.content,
      });
    }
  }

  hasActiveTextPart(state: ActiveRunRenderState): boolean {
    return Boolean(state.activeTextPartId);
  }

  applyStreamEvent(state: ActiveRunRenderState, event: StreamEvent): AppliedStreamEvent {
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
          });
          state.activeTextPartId = part.id;
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
        this.completeActiveTextPart(state, "completed");
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
        });
        state.toolParts.delete(event.toolUseId);
        return { completedToolName: active?.toolName };
      }
      case "usage": {
        this.store.updateRun(state.runId, { metadata: { usage: event.usage } });
        return {};
      }
      case "complete": {
        this.completeActiveTextPart(state, "completed");
        state.assistantTurnCompleted = true;
        this.store.updateRun(state.runId, { metadata: { stopReason: event.stopReason } });
        return {};
      }
      case "error": {
        const messageId = this.ensureAssistantMessage(state, true);
        this.completeActiveTextPart(state, "failed");
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

  completeActiveTextPart(
    state: ActiveRunRenderState,
    status: Extract<SessionMessagePartStatus, "completed" | "failed" | "interrupted">,
  ): void {
    if (!state.assistantMessageId || !state.activeTextPartId) return;
    this.store.upsertMessagePart({
      id: state.activeTextPartId,
      sessionId: state.sessionId,
      messageId: state.assistantMessageId,
      type: "text",
      status,
    });
    delete state.activeTextPartId;
  }

  private ensureAssistantMessage(state: ActiveRunRenderState, startTurn = false): string {
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
}
