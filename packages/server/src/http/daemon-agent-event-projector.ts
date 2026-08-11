import type { OpenHarnessAgent } from "@openharness/agent-runtime";
import type { AgentEvent, ContentBlock, StreamEvent } from "@openharness/core";
import type { SessionInputRecord, SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import type { LiveChildAgentDirectory } from "./live-child-agent-directory.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionTaskBridge, SessionTaskBridgeManager } from "./session-task-bridge.js";
import type { ActiveTranscriptProjectionState, SessionTranscriptProjection } from "./transcript-projection.js";

interface ChildProjectionState {
  childId: string;
  sessionId: string;
  parentSessionId: string;
  taskId: string;
  bridge: SessionTaskBridge;
}

export interface DaemonAgentEventProjectorContext {
  rootAgent: OpenHarnessAgent;
  store: SessionStore;
  transcriptProjection: SessionTranscriptProjection;
  taskBridgeManager: Pick<SessionTaskBridgeManager, "createBridge">;
  liveChildren: Pick<LiveChildAgentDirectory, "register" | "unregister">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publish" | "publishSince">;
  log(event: ObservabilityEvent): void;
}

/** Applies framework execution facts to daemon-owned durable product state. */
export class DaemonAgentEventProjector {
  private readonly transcripts = new Map<string, ActiveTranscriptProjectionState>();
  private readonly children = new Map<string, ChildProjectionState>();
  private lastAppliedSequence = 0;

  constructor(private readonly context: DaemonAgentEventProjectorContext) {}

  async apply(event: AgentEvent): Promise<void> {
    if (event.sequence <= this.lastAppliedSequence) return;
    await this.project(event);
    this.lastAppliedSequence = event.sequence;
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
    const existing = this.context.store.getSession(sessionId);
    if (existing && (existing.parentId !== parent.id || existing.cwd !== cwd)) {
      throw new Error(`Child session identity conflict: ${sessionId}`);
    }

    let createdSession = false;
    let bridge: SessionTaskBridge | undefined;
    let taskId: string | undefined;
    let liveRegistered = false;
    try {
      if (!existing) {
        const before = this.context.events.checkpoint();
        this.context.store.createSession({
          id: sessionId,
          parentId: parent.id,
          cwd,
          model: spawn.model ?? parent.model,
          title: `${spawn.agent}@${spawn.team ?? "default"}`,
          agent: spawn.agent,
          metadata: {
            ...spawn.metadata,
            team: spawn.team ?? "default",
            systemPrompt: spawn.systemPrompt,
            permissionMode: spawn.permissionMode,
            allowedTools: spawn.allowedTools,
            disallowedTools: spawn.disallowedTools,
            maxTurns: spawn.maxTurns,
            effort: spawn.effort,
            isolate: spawn.isolate,
            childId,
            ...(worktree ? { worktree } : {}),
          },
        });
        createdSession = true;
        this.context.events.publishSince(before);
      }

      bridge = this.context.taskBridgeManager.createBridge({ id: parent.id, cwd: parent.cwd });
      taskId = this.context.store.getSessionTask(childId)?.id;
      if (!taskId) {
        taskId = bridge.registerSessionTask({
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
        }).id;
      }
      this.context.liveChildren.register(sessionId, childId, this.context.rootAgent);
      liveRegistered = true;
      this.children.set(childId, { childId, sessionId, parentSessionId: parent.id, taskId, bridge });
    } catch (error) {
      if (liveRegistered) this.context.liveChildren.unregister(sessionId, childId);
      this.children.delete(childId);
      const message = error instanceof Error ? error.message : String(error);
      if (taskId && bridge) {
        await bridge.completeSessionTask(taskId, { status: "failed", output: message }).catch(() => {});
      }
      if (createdSession) {
        const before = this.context.events.checkpoint();
        try {
          this.context.store.archiveSession(sessionId);
          this.context.events.publishSince(before);
        } catch {
          // Preserve the original projection failure.
        }
      }
      throw error;
    }
  }

  private async projectChildClosed(event: Extract<AgentEvent, { type: "child.closed" }>): Promise<void> {
    const state = this.children.get(event.data.childId);
    this.context.liveChildren.unregister(event.data.sessionId, event.data.childId);
    if (state) {
      const task = this.context.store.getSessionTask(state.taskId);
      if (task && (task.status === "pending" || task.status === "running")) {
        await state.bridge.completeSessionTask(state.taskId, event.data.result).catch(() => {});
      }
      this.children.delete(state.childId);
    }
    this.appendRuntimeEvent(event, {
      childId: event.data.childId,
      childSessionId: event.data.sessionId,
      result: event.data.result,
    });
  }

  private projectInput(event: Extract<AgentEvent, { type: "input.accepted" }>): void {
    const sessionId = event.context.sessionId;
    const inputId = required(event.context.inputId, "inputId", event.type);
    let input = this.context.store.getInput(inputId);
    const content = contentToText(event.data.content);
    if (!input) {
      const before = this.context.events.checkpoint();
      input = this.context.store.admitPrompt({
        id: inputId,
        sessionId,
        delivery: event.data.delivery,
        content,
        metadata: {
          ...(event.context.traceId ? { traceId: event.context.traceId } : {}),
          ...(event.context.parentRunId ? { parentRunId: event.context.parentRunId } : {}),
        },
      });
      this.context.events.publishSince(before);
    } else if (input.sessionId !== sessionId || input.content !== content || input.delivery !== event.data.delivery) {
      throw new Error(`Agent input identity conflict: ${inputId}`);
    }

    const runId = event.context.runId;
    const transcript = runId ? this.transcripts.get(runId) : undefined;
    if (transcript && event.data.delivery === "steer") {
      const before = this.context.events.checkpoint();
      this.context.transcriptProjection.projectSteeredInputs(transcript, [input]);
      this.context.events.publishSince(before);
    }
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
    }
    this.context.store.updateRun(runId, { status: "running" });
    this.transcripts.set(runId, this.context.transcriptProjection.beginRun(sessionId, inputId, runId, input.content));
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
    if (child) await child.bridge.bindSessionTaskRun(child.taskId, runId);
  }

  private projectStream(event: AgentEvent, stream: StreamEvent): void {
    const runId = required(event.context.runId, "runId", event.type);
    const state = this.transcripts.get(runId);
    if (!state) throw new Error(`Transcript projection not started for run: ${runId}`);
    const direct = stream.type === "text_delta" && this.context.transcriptProjection.hasOpenTextPart(state);
    const before = direct ? undefined : this.context.events.checkpoint();
    const applied = this.context.transcriptProjection.projectStreamEvent(state, stream);
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
    if (direct && applied.liveEvent) this.context.events.publish(applied.liveEvent);
    else if (before !== undefined) this.context.events.publishSince(before);
  }

  private async finishRun(
    event: Extract<AgentEvent, { type: "run.completed" | "run.failed" | "run.interrupted" }>,
  ): Promise<void> {
    const runId = required(event.context.runId, "runId", event.type);
    const state = this.transcripts.get(runId);
    const before = this.context.events.checkpoint();
    const interrupted = event.type === "run.interrupted";
    const failed = event.type === "run.failed";
    if (state) {
      this.context.transcriptProjection.completeOpenTextPart(
        state,
        interrupted ? "interrupted" : failed ? "failed" : "completed",
      );
    }
    const error = event.type === "run.completed" ? undefined : event.data.error.message;
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
        await child.bridge.completeSessionTask(child.taskId, result);
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
