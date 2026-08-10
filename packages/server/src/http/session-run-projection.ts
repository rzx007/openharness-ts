import type {
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunScope,
  AgentRuntimeEvent,
  StreamEvent,
} from "@openharness/core";
import type { SessionInputRecord, SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import type { StorePermissionBroker } from "../permission-broker.js";
import { DaemonRuntimeHostPort } from "./daemon-runtime-host.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { ActiveTranscriptProjectionState, SessionTranscriptProjection } from "./transcript-projection.js";

export interface DaemonRunProjectionContext {
  store: Pick<SessionStore, "appendEvent" | "listUnboundInputs" | "updateRun">;
  permissionBroker: Pick<StorePermissionBroker, "ask">;
  transcriptProjection: SessionTranscriptProjection;
  events: Pick<SessionEventPublisher, "checkpoint" | "publish" | "publishSince">;
  sessionId: string;
  inputId: string;
  runId: string;
  traceId: string;
  signal: AbortSignal;
  log(event: ObservabilityEvent): void;
}

/**
 * Run-scoped daemon projection adapter.
 *
 * Runtime/framework code emits host events, stream events, and permission asks.
 * This adapter decides how those live signals become durable store state,
 * event publication, and observability records.
 */
export class DaemonRunProjection {
  private transcriptState?: ActiveTranscriptProjectionState;

  constructor(private readonly context: DaemonRunProjectionContext) {}

  start(content: string): void {
    const before = this.context.events.checkpoint();
    this.context.store.updateRun(this.context.runId, { status: "running" });
    this.context.log({
      level: "info",
      event: "session.run.started",
      traceId: this.context.traceId,
      sessionId: this.context.sessionId,
      runId: this.context.runId,
    });
    this.transcriptState = this.context.transcriptProjection.beginRun(
      this.context.sessionId,
      this.context.inputId,
      this.context.runId,
      content,
    );
    this.context.events.publishSince(before);
  }

  drainSteeredInputs(): SessionInputRecord[] {
    const pending = this.context.store.listUnboundInputs(this.context.sessionId);
    if (pending.length === 0) return pending;
    this.projectSteeredInputs(pending);
    return pending;
  }

  projectSteeredInputs(pending: SessionInputRecord[], checkpoint?: number): void {
    if (pending.length === 0) return;
    const before = checkpoint ?? this.context.events.checkpoint();
    this.context.transcriptProjection.projectSteeredInputs(this.requireTranscriptState(), pending);
    this.context.events.publishSince(before);
  }

  createHost(scope: AgentRunScope): DaemonRuntimeHostPort {
    return new DaemonRuntimeHostPort({
      scope,
      emitEvent: (event) => this.emitEvent(event),
      emitStreamEvent: (event) => this.emitStreamEvent(event),
      requestPermission: (request) => this.requestPermission(request),
    });
  }

  complete(interrupted: boolean): void {
    const before = this.context.events.checkpoint();
    this.context.transcriptProjection.completeOpenTextPart(this.requireTranscriptState(), "completed");
    this.context.store.updateRun(this.context.runId, { status: interrupted ? "interrupted" : "completed" });
    this.context.log({
      level: interrupted ? "warn" : "info",
      event: interrupted ? "session.run.interrupted" : "session.run.completed",
      traceId: this.context.traceId,
      sessionId: this.context.sessionId,
      runId: this.context.runId,
    });
    this.context.events.publishSince(before);
  }

  fail(error: unknown, interrupted: boolean): void {
    const before = this.context.events.checkpoint();
    const message = error instanceof Error ? error.message : String(error);
    const event = interrupted ? "session.run.interrupted" : "session.run.error";
    this.context.store.appendEvent({
      type: event,
      sessionId: this.context.sessionId,
      payload: { runId: this.context.runId, traceId: this.context.traceId, error: message },
    });
    this.context.store.updateRun(this.context.runId, {
      status: interrupted ? "interrupted" : "failed",
      error: message,
    });
    this.context.log({
      level: interrupted ? "warn" : "error",
      event: interrupted ? "session.run.interrupted" : "session.run.failed",
      traceId: this.context.traceId,
      sessionId: this.context.sessionId,
      runId: this.context.runId,
      error: message,
    });
    this.context.events.publishSince(before);
  }

  private emitEvent(event: AgentRuntimeEvent): void {
    const before = this.context.events.checkpoint();
    this.context.store.appendEvent({
      type: event.type,
      sessionId: this.context.sessionId,
      payload: event.payload,
    });
    this.context.events.publishSince(before);
  }

  private emitStreamEvent(event: StreamEvent): void {
    const transcriptState = this.requireTranscriptState();
    const canDirectBroadcast =
      event.type === "text_delta" && this.context.transcriptProjection.hasOpenTextPart(transcriptState);
    const before = canDirectBroadcast ? undefined : this.context.events.checkpoint();
    const applied = this.context.transcriptProjection.projectStreamEvent(transcriptState, event);
    if (event.type === "tool_use_start") {
      this.context.log({
        level: "info",
        event: "session.tool.started",
        traceId: this.context.traceId,
        sessionId: this.context.sessionId,
        runId: this.context.runId,
        toolName: event.toolUse.name,
      });
    } else if (event.type === "tool_use_end") {
      this.context.log({
        level: event.result.isError ? "warn" : "info",
        event: "session.tool.completed",
        traceId: this.context.traceId,
        sessionId: this.context.sessionId,
        runId: this.context.runId,
        toolName: applied.completedToolName,
        ...(event.result.isError ? { error: "tool returned an error" } : {}),
      });
    }
    if (canDirectBroadcast && applied.liveEvent) {
      this.context.events.publish(applied.liveEvent);
    } else if (before !== undefined) {
      this.context.events.publishSince(before);
    }
  }

  private async requestPermission(request: AgentPermissionRequest): Promise<AgentPermissionDecision> {
    const approved = await this.context.permissionBroker.ask({
      sessionId: this.context.sessionId,
      runId: this.context.runId,
      traceId: this.context.traceId,
      toolName: request.toolName,
      reason: request.reason,
      input: request.input,
      signal: this.context.signal,
    });
    return approved ? { status: "approved" } : { status: "denied" };
  }

  private requireTranscriptState(): ActiveTranscriptProjectionState {
    if (!this.transcriptState) throw new Error("Run projection has not started");
    return this.transcriptState;
  }
}
