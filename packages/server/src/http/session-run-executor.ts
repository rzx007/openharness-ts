import type { SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import type { StorePermissionBroker } from "../permission-broker.js";
import { RunInterruptedError, type SessionRunWorkContext } from "../run-coordinator.js";
import type { ChildAgentHostFactory } from "./child-agent-host-factory.js";
import { DaemonRuntimeHostPort } from "./daemon-runtime-host.js";
import type { SessionRunRenderer } from "./run-renderer.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionRuntimePool } from "./session-runtime-pool.js";

export interface SessionRunExecutorContext {
  store: SessionStore;
  runtimePool: SessionRuntimePool;
  childAgentHostFactory: ChildAgentHostFactory;
  permissionBroker: Pick<StorePermissionBroker, "ask">;
  runRenderer: SessionRunRenderer;
  events: Pick<SessionEventPublisher, "checkpoint" | "publish" | "publishSince">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}
export interface ExecuteSessionRunInput {
  sessionId: string;
  inputId: string;
  runId: string;
}

/**
 * Single admitted-run executor. It builds a run-scoped host, renders stream
 * events into message/part records, and updates the run terminal state.
 */
export class SessionRunExecutor {
  constructor(private readonly context: SessionRunExecutorContext) {}

  async execute(input: ExecuteSessionRunInput, workContext: SessionRunWorkContext): Promise<void> {
    if (!this.context.runtimePool.configured) return;
    const { sessionId, inputId, runId } = input;
    let before = this.context.events.checkpoint();
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
      this.context.events.publishSince(before);

      const drainSteeredInputs = () => {
        const pending = this.context.store.listUnboundInputs(sessionId);
        if (pending.length === 0) return pending;
        const eventBefore = this.context.events.checkpoint();
        this.context.runRenderer.drainSteeredInputs(renderState, pending);
        this.context.events.publishSince(eventBefore);
        return pending;
      };

      const runtime = await this.context.runtimePool.acquire(session, history, parts);
      const scope = {
        sessionId,
        inputId,
        runId,
        cwd: session.cwd,
        traceId,
        signal: workContext.signal,
      };
      const childAgentHost = this.context.childAgentHostFactory.create({ scope, session });
      const host = new DaemonRuntimeHostPort({
        scope,
        childAgentHost,
        emitEvent: (event) => {
          const eventBefore = this.context.events.checkpoint();
          this.context.store.appendEvent({
            type: event.type,
            sessionId,
            payload: event.payload,
          });
          this.context.events.publishSince(eventBefore);
        },
        emitStreamEvent: (event) => {
          const canDirectBroadcast =
            event.type === "text_delta" && this.context.runRenderer.hasActiveTextPart(renderState);
          const eventBefore = canDirectBroadcast ? undefined : this.context.events.checkpoint();
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
            this.context.events.publish(applied.liveEvent);
          } else if (eventBefore !== undefined) {
            this.context.events.publishSince(eventBefore);
          }
        },
        requestPermission: async (request) => {
          const approved = await this.context.permissionBroker.ask({
            sessionId,
            runId,
            traceId,
            toolName: request.toolName,
            reason: request.reason,
            input: request.input,
            signal: workContext.signal,
          });
          return approved ? { status: "approved" } : { status: "denied" };
        },
      });
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
        host,
      );

      before = this.context.events.checkpoint();
      this.context.runRenderer.completeActiveTextPart(renderState, "completed");
      this.context.store.updateRun(runId, { status: workContext.signal.aborted ? "interrupted" : "completed" });
      this.context.log({
        level: workContext.signal.aborted ? "warn" : "info",
        event: workContext.signal.aborted ? "session.run.interrupted" : "session.run.completed",
        traceId,
        sessionId,
        runId,
      });
      this.context.events.publishSince(before);
    } catch (error) {
      await this.context.runtimePool.close(sessionId);
      before = this.context.events.checkpoint();
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
      this.context.events.publishSince(before);
    }
  }
}
