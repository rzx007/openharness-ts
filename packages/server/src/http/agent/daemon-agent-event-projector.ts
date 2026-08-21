import type { OpenHarnessAgent } from "@openharness/agent-runtime";
import type { AgentEvent, ContentBlock, StreamEvent } from "@openharness/core";
import {
  patchSessionRuntimeMetadata,
  readSessionRuntimeConfig,
  type SessionInputRecord,
  type SessionStore,
} from "@openharness/services";

import type { ObservabilityEvent } from "../../shared/observability.js";
import type { LiveChildAgentDirectory } from "./live-child-agent-directory.js";
import type { SessionEventPublisher } from "../session/session-event-publisher.js";
import type {
  SessionChildExecutionBridge,
  SessionExecutionProjector,
} from "../session/session-execution-projector.js";
import type { ActiveTranscriptProjectionState, SessionTranscriptProjection } from "../session/transcript-projection.js";
import { jsonEqual, withoutTraceId } from "../support.js";

interface ChildProjectionState {
  childId: string;
  sessionId: string;
  parentSessionId: string;
  taskId: string;
  bridge: SessionChildExecutionBridge;
}

interface PendingEventSettlement {
  event: AgentEvent;
  action: "retry-projection" | "compensate-child";
  cause: unknown;
}

export interface DaemonAgentEventProjectorContext {
  rootAgent: OpenHarnessAgent;
  store: SessionStore;
  transcriptProjection: SessionTranscriptProjection;
  executionProjector: Pick<SessionExecutionProjector, "createBridge">;
  liveChildren: Pick<LiveChildAgentDirectory, "register" | "unregister">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publish" | "publishSince">;
  log(event: ObservabilityEvent): void;
}

/** Applies framework execution facts to daemon-owned durable product state. */
export class DaemonAgentEventProjector {
  private readonly transcripts = new Map<string, ActiveTranscriptProjectionState>();
  private readonly children = new Map<string, ChildProjectionState>();
  private lastAppliedSequence = 0;
  private pendingSettlement?: PendingEventSettlement;

  constructor(private readonly context: DaemonAgentEventProjectorContext) {}

  async apply(event: AgentEvent): Promise<void> {
    await this.reconcilePendingSettlement();
    if (event.sequence <= this.lastAppliedSequence) return;
    try {
      await this.project(event);
      this.lastAppliedSequence = event.sequence;
    } catch (error) {
      let recovered = false;
      if (event.context.childId) {
        const settlement: PendingEventSettlement = {
          event,
          action: event.type === "child.closed" ? "retry-projection" : "compensate-child",
          cause: error,
        };
        try {
          await this.settle(settlement);
          this.lastAppliedSequence = event.sequence;
          recovered = settlement.action === "retry-projection";
        } catch (settlementError) {
          this.pendingSettlement = settlement;
          this.context.log({
            level: "error",
            event: "session.child_projection.compensation_failed",
            traceId: event.context.traceId,
            sessionId: event.context.sessionId,
            runId: event.context.runId,
            error: settlementError instanceof Error ? settlementError.message : String(settlementError),
          });
        }
      }
      if (recovered) return;
      throw error;
    }
  }

  private async project(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "child.created":
        await this.projectChildCreated(event);
        return;
      case "child.closed":
        await this.projectChildClosed(event);
        return;
      case "child.suspended":
      case "child.resumed":
        this.appendRuntimeEvent(event, { childId: event.data.childId, childSessionId: event.data.sessionId });
        return;
      case "input.accepted":
        this.projectInput(event);
        return;
      case "run.started":
        await this.startRun(event);
        return;
      case "output.text.delta":
        this.projectStream(event, { type: "text_delta", delta: event.data.delta });
        return;
      case "output.turn.completed":
        this.projectStream(event, { type: "complete", stopReason: event.data.stopReason });
        return;
      case "tool.started":
        this.projectStream(event, { type: "tool_use_start", toolUse: event.data.toolUse });
        return;
      case "tool.completed":
        this.projectStream(event, {
          type: "tool_use_end",
          toolUseId: event.data.toolUseId,
          result: event.data.result,
        });
        return;
      case "usage.updated":
        this.projectStream(event, { type: "usage", usage: event.data.usage });
        return;
      case "domain.event":
        this.appendRuntimeEvent(event, event.data.payload, event.data.name);
        return;
      case "permission.requested":
      case "permission.resolved":
        this.appendRuntimeEvent(event, { ...event.data });
        return;
      case "run.completed":
      case "run.failed":
      case "run.interrupted":
        await this.finishRun(event);
        return;
    }
  }

  private async projectChildCreated(event: Extract<AgentEvent, { type: "child.created" }>): Promise<void> {
    const { childId, sessionId, spawn, cwd, worktree } = event.data;
    const parent = this.context.store.getSession(event.context.sessionId);
    if (!parent) throw new Error(`Parent session not found for child ${childId}: ${event.context.sessionId}`);
    if (parent.status === "closing" || parent.status === "archived") {
      throw new Error(`Parent session is not accepting child agents: ${parent.id}`);
    }
    const existing = this.context.store.getSession(sessionId);
    if (
      existing &&
      (existing.parentId !== parent.id || existing.cwd !== cwd || existing.metadata.childId !== childId)
    ) {
      throw new Error(`Child session identity conflict: ${sessionId}`);
    }

    if (!existing) {
      const before = this.context.events.checkpoint();
      const parentRuntime = readSessionRuntimeConfig(parent);
      const model = spawn.model ?? parentRuntime.model;
      const runtimePatch = {
        ...parentRuntime,
        model,
        ...(spawn.systemPrompt !== undefined ? { systemPrompt: spawn.systemPrompt } : {}),
        ...(spawn.permissionMode !== undefined ? { permissionMode: spawn.permissionMode } : {}),
        ...(spawn.allowedTools !== undefined ? { allowedTools: spawn.allowedTools } : {}),
        ...(spawn.disallowedTools !== undefined ? { disallowedTools: spawn.disallowedTools } : {}),
        ...(spawn.maxTurns !== undefined ? { maxTurns: spawn.maxTurns } : {}),
        ...(isRuntimeEffort(spawn.effort) ? { effort: spawn.effort } : {}),
      };
      this.context.store.createSession({
          id: sessionId,
          parentId: parent.id,
          cwd,
          model,
          title: `${spawn.agent}@${spawn.team ?? "default"}`,
          agent: spawn.agent,
          metadata: patchSessionRuntimeMetadata({
            ...spawn.metadata,
            team: spawn.team ?? "default",
            isolate: spawn.isolate,
            childId,
            ...(worktree ? { worktree } : {}),
          }, runtimePatch),
      });
      this.context.events.publishSince(before);
    }

    const bridge = this.context.executionProjector.createBridge({ id: parent.id, cwd: parent.cwd });
    let taskId = this.context.store.getSessionTask(childId)?.id;
    if (!taskId) {
      taskId = childId;
      const registered = bridge.registerChildExecution({
          id: childId,
          description: spawn.description,
          cwd,
          sessionId: parent.id,
          childSessionId: sessionId,
          prompt: spawn.prompt,
          onInput: async (content) => {
            const child = this.context.rootAgent.children.get(childId);
            if (!child) throw new Error(`Live child not found: ${childId}`);
            await child.send({ content });
          },
          onStop: async () => {
            await this.context.rootAgent.children.get(childId)?.interrupt("Child agent stopped");
          },
      });
      if (registered.id !== taskId) throw new Error(`Child task identity conflict: ${registered.id}/${taskId}`);
    }
    this.context.liveChildren.register(sessionId, childId, this.context.rootAgent);
    this.children.set(childId, { childId, sessionId, parentSessionId: parent.id, taskId, bridge });
  }

  private async projectChildClosed(event: Extract<AgentEvent, { type: "child.closed" }>): Promise<void> {
    const state = this.children.get(event.data.childId);
    await this.completeChildCloseProjection(event, state);
  }

  private projectInput(event: Extract<AgentEvent, { type: "input.accepted" }>): void {
    const sessionId = event.context.sessionId;
    const inputId = required(event.context.inputId, "inputId", event.type);
    const content = contentToText(event.data.content);
    const metadata = {
      ...event.data.metadata,
      ...(event.context.traceId ? { traceId: event.context.traceId } : {}),
    };
    const runId = event.context.runId;
    const transcript = runId ? this.transcripts.get(runId) : undefined;
    const transcriptSnapshot = transcript ? snapshotTranscript(transcript) : undefined;
    const before = this.context.events.checkpoint();
    try {
      this.context.store.transaction(() => {
        let input = this.context.store.getInput(inputId);
        if (!input) {
          input = this.context.store.admitPrompt({
            id: inputId,
            sessionId,
            delivery: event.data.delivery,
            content,
            metadata,
          });
        } else if (
          input.sessionId !== sessionId ||
          input.content !== content ||
          input.delivery !== event.data.delivery ||
          !jsonEqual(withoutTraceId(input.metadata), withoutTraceId(metadata))
        ) {
          throw new Error(`Agent input identity conflict: ${inputId}`);
        }

        if (transcript && event.data.delivery === "steer") {
          this.context.transcriptProjection.projectSteeredInputs(transcript, [input]);
        }
      });
    } catch (error) {
      if (transcript && transcriptSnapshot) restoreTranscript(transcript, transcriptSnapshot);
      throw error;
    }
    this.context.events.publishSince(before);
  }

  private async startRun(event: Extract<AgentEvent, { type: "run.started" }>): Promise<void> {
    const sessionId = event.context.sessionId;
    const runId = required(event.context.runId, "runId", event.type);
    const inputId = required(event.context.inputId, "inputId", event.type);
    const input = this.context.store.getInput(inputId);
    if (!input) throw new Error(`Agent run input not found: ${inputId}`);
    if (this.transcripts.has(runId)) {
      await this.bindChildTaskRun(event, runId);
      return;
    }

    const before = this.context.events.checkpoint();
    const transcript = this.context.store.transaction(() => {
      const existing = this.context.store.getRun(runId);
      if (!existing) {
        this.context.store.createRun({
          id: runId,
          sessionId,
          inputId,
          metadata: {
            ...(event.context.traceId ? { traceId: event.context.traceId } : {}),
            ...(event.context.parentRunId ? { parentRunId: event.context.parentRunId } : {}),
          },
        });
      } else if (existing.sessionId !== sessionId || existing.inputId !== inputId) {
        throw new Error(`Agent run identity conflict: ${runId}`);
      } else if (existing.status === "completed" || existing.status === "failed" || existing.status === "interrupted") {
        throw new Error(`Agent run is already terminal: ${runId}`);
      }
      this.context.store.updateRun(runId, { status: "running" });
      return this.context.transcriptProjection.beginRun(sessionId, inputId, runId, input.content);
    });
    this.transcripts.set(runId, transcript);
    this.context.log({
      level: "info",
      event: "session.run.started",
      traceId: event.context.traceId,
      sessionId,
      runId,
    });
    this.context.events.publishSince(before);

    await this.bindChildTaskRun(event, runId);
  }

  private async bindChildTaskRun(event: AgentEvent, runId: string): Promise<void> {
    if (!event.context.childId) return;
    const child = this.children.get(event.context.childId);
    if (child) await child.bridge.bindChildExecutionRun(child.taskId, runId);
  }

  private projectStream(event: AgentEvent, stream: StreamEvent): void {
    const runId = required(event.context.runId, "runId", event.type);
    const state = this.transcripts.get(runId);
    if (!state) throw new Error(`Transcript projection not started for run: ${runId}`);
    const stateSnapshot = snapshotTranscript(state);
    const direct = stream.type === "text_delta" && this.context.transcriptProjection.hasOpenTextPart(state);
    const before = direct ? undefined : this.context.events.checkpoint();
    let applied: ReturnType<SessionTranscriptProjection["projectStreamEvent"]>;
    try {
      applied = direct
        ? this.context.transcriptProjection.projectStreamEvent(state, stream)
        : this.context.store.transaction(() =>
            this.context.transcriptProjection.projectStreamEvent(state, stream));
    } catch (error) {
      restoreTranscript(state, stateSnapshot);
      throw error;
    }
    if (stream.type === "tool_use_start") {
      this.context.log({
        level: "info",
        event: "session.tool.started",
        traceId: event.context.traceId,
        sessionId: event.context.sessionId,
        runId,
        toolName: stream.toolUse.name,
      });
    } else if (stream.type === "tool_use_end") {
      this.context.log({
        level: stream.result.isError ? "warn" : "info",
        event: "session.tool.completed",
        traceId: event.context.traceId,
        sessionId: event.context.sessionId,
        runId,
        toolName: applied.completedToolName,
        ...(stream.result.isError ? { error: "tool returned an error" } : {}),
      });
    }
    if (before !== undefined) this.context.events.publishSince(before);
    if (applied.liveEvent) this.context.events.publish(applied.liveEvent);
  }

  private async finishRun(
    event: Extract<AgentEvent, { type: "run.completed" | "run.failed" | "run.interrupted" }>,
  ): Promise<void> {
    const runId = required(event.context.runId, "runId", event.type);
    const state = this.transcripts.get(runId);
    const stateSnapshot = state ? snapshotTranscript(state) : undefined;
    const before = this.context.events.checkpoint();
    const interrupted = event.type === "run.interrupted";
    const failed = event.type === "run.failed";
    const error = event.type === "run.completed" ? undefined : event.data.error.message;
    try {
      this.context.store.transaction(() => {
        if (state) {
          this.context.transcriptProjection.completeOpenTextPart(
            state,
            interrupted ? "interrupted" : failed ? "failed" : "completed",
          );
        }
        if (error) {
          this.context.store.appendEvent({
            type: interrupted ? "session.run.interrupted" : "session.run.error",
            sessionId: event.context.sessionId,
            payload: { runId, traceId: event.context.traceId, error },
          });
        }
        this.context.store.updateRun(runId, {
          status: interrupted ? "interrupted" : failed ? "failed" : "completed",
          ...(error ? { error } : {}),
          ...(event.type === "run.completed" && event.data.stopReason
            ? { metadata: { stopReason: event.data.stopReason } }
            : {}),
        });
      });
    } catch (projectionError) {
      if (state && stateSnapshot) restoreTranscript(state, stateSnapshot);
      throw projectionError;
    }
    this.context.log({
      level: failed ? "error" : interrupted ? "warn" : "info",
      event: failed ? "session.run.failed" : interrupted ? "session.run.interrupted" : "session.run.completed",
      traceId: event.context.traceId,
      sessionId: event.context.sessionId,
      runId,
      ...(error ? { error } : {}),
    });
    this.context.events.publishSince(before);
    this.transcripts.delete(runId);

    if (event.context.childId) {
      const child = this.children.get(event.context.childId);
      if (child) {
        const result = event.type === "run.completed"
          ? { status: "completed" as const, output: event.data.output }
          : {
              status: interrupted ? "interrupted" as const : "failed" as const,
              output: event.data.output ?? error ?? "",
              ...(error ? { error } : {}),
            };
        await child.bridge.completeChildExecution(child.taskId, result);
      }
    }
  }

  private appendRuntimeEvent(event: AgentEvent, payload?: Record<string, unknown>, type = `agent.${event.type}`): void {
    const before = this.context.events.checkpoint();
    this.context.store.appendEvent({
      type,
      sessionId: event.context.sessionId,
      payload: { frameworkEventId: event.id, ...payload },
    });
    this.context.events.publishSince(before);
  }

  private async compensateChildProjectionFailure(event: AgentEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const runId = event.context.runId;
    if (runId) {
      const run = this.context.store.getRun(runId);
      if (run && (run.status === "pending" || run.status === "running")) {
        const before = this.context.events.checkpoint();
        this.context.store.transaction(() => {
          this.context.transcriptProjection.finalizeRunParts(event.context.sessionId, runId, "failed");
          this.context.store.appendEvent({
            type: "session.run.error",
            sessionId: event.context.sessionId,
            payload: { runId, traceId: event.context.traceId, error: message, projectionFailure: true },
          });
          this.context.store.updateRun(runId, { status: "failed", error: message });
        });
        this.context.events.publishSince(before);
      }
      this.transcripts.delete(runId);
    }

    const child = this.children.get(event.context.childId!);
    if (!child) return;
    const task = this.context.store.getSessionTask(child.taskId);
    if (task && (task.status === "pending" || task.status === "running")) {
      await child.bridge.completeChildExecution(child.taskId, { status: "failed", output: message });
    }
  }

  private async compensateChildCreationFailure(event: AgentEvent, error: unknown): Promise<void> {
    const childId = event.context.childId!;
    const childSessionId = event.type === "child.created" ? event.data.sessionId : event.context.sessionId;
    const message = error instanceof Error ? error.message : String(error);
    this.context.liveChildren.unregister(childSessionId, childId);
    this.children.delete(childId);

    const task = this.context.store.getSessionTask(childId);
    const parent = this.context.store.getSession(event.context.sessionId);
    if (task && parent && (task.status === "pending" || task.status === "running")) {
      const bridge = this.context.executionProjector.createBridge({ id: parent.id, cwd: parent.cwd });
      await bridge.completeChildExecution(task.id, { status: "failed", output: message });
    }

    const child = this.context.store.getSession(childSessionId);
    if (child && child.status !== "archived") {
      const before = this.context.events.checkpoint();
      this.context.store.archiveSession(childSessionId);
      this.context.events.publishSince(before);
    }
  }

  private async reconcilePendingSettlement(): Promise<void> {
    const pending = this.pendingSettlement;
    if (!pending) return;
    await this.settle(pending);
    this.lastAppliedSequence = Math.max(this.lastAppliedSequence, pending.event.sequence);
    if (this.pendingSettlement === pending) this.pendingSettlement = undefined;
  }

  private async settle(pending: PendingEventSettlement): Promise<void> {
    if (pending.action === "retry-projection") {
      await this.project(pending.event);
      return;
    }
    if (pending.event.type === "child.created") {
      await this.compensateChildCreationFailure(pending.event, pending.cause);
      return;
    }
    await this.compensateChildProjectionFailure(pending.event, pending.cause);
  }

  private async completeChildCloseProjection(
    event: Extract<AgentEvent, { type: "child.closed" }>,
    state: ChildProjectionState | undefined,
  ): Promise<void> {
    this.context.liveChildren.unregister(event.data.sessionId, event.data.childId);
    if (state) {
      const task = this.context.store.getSessionTask(state.taskId);
      if (task && (task.status === "pending" || task.status === "running")) {
        await state.bridge.completeChildExecution(state.taskId, event.data.result);
      }
    }
    this.appendRuntimeEvent(event, {
      childId: event.data.childId,
      childSessionId: event.data.sessionId,
      result: event.data.result,
    });
    if (state) this.children.delete(state.childId);
  }
}

function isRuntimeEffort(value: unknown): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function snapshotTranscript(state: ActiveTranscriptProjectionState): ActiveTranscriptProjectionState {
  return { ...state, toolParts: new Map(state.toolParts) };
}

function restoreTranscript(
  state: ActiveTranscriptProjectionState,
  snapshot: ActiveTranscriptProjectionState,
): void {
  for (const key of Object.keys(state) as Array<keyof ActiveTranscriptProjectionState>) {
    delete (state as Partial<ActiveTranscriptProjectionState>)[key];
  }
  Object.assign(state, snapshot, { toolParts: new Map(snapshot.toolParts) });
}

function required(value: string | undefined, name: string, eventType: string): string {
  if (!value) throw new Error(`${eventType} is missing ${name}`);
  return value;
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}
