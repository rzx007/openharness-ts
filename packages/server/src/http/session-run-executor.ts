import type { SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import type { StorePermissionBroker } from "../permission-broker.js";
import { RunInterruptedError, type SessionRunWorkContext } from "../run-coordinator.js";
import type { ChildAgentHostFactory } from "./child-agent-host-factory.js";
import { DaemonRunProjection } from "./session-run-projection.js";
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
    let projection: DaemonRunProjection | undefined;
    try {
      const session = this.context.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const history = this.context.store.listMessages(sessionId);
      const parts = this.context.store.listMessageParts(sessionId);
      const admitted = this.context.store.getInput(inputId);
      if (!admitted) throw new Error(`Session input not found: ${inputId}`);
      const traceId = this.context.traceIdForRun(runId);
      projection = new DaemonRunProjection({
        store: this.context.store,
        permissionBroker: this.context.permissionBroker,
        runRenderer: this.context.runRenderer,
        events: this.context.events,
        sessionId,
        inputId,
        runId,
        traceId,
        signal: workContext.signal,
        log: this.context.log,
      });
      projection.start(admitted.content);

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
      const host = projection.createHost(scope, childAgentHost);
      await runtime.runPrompt(
        {
          session,
          input: admitted,
          runId,
          history,
          parts,
          signal: workContext.signal,
          wakeCount: workContext.wakeCount,
          drainSteeredInputs: () => projection!.drainSteeredInputs(),
        },
        host,
      );

      projection.complete(workContext.signal.aborted);
    } catch (error) {
      await this.context.runtimePool.close(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      const traceId = this.context.traceIdForRun(runId);
      const interrupted = error instanceof RunInterruptedError || workContext.signal.aborted;
      if (projection) {
        projection.fail(error, interrupted);
        return;
      }
      const before = this.context.events.checkpoint();
      this.context.store.appendEvent({
        type: interrupted ? "session.run.interrupted" : "session.run.error",
        sessionId,
        payload: { runId, traceId, error: message },
      });
      this.context.store.updateRun(runId, { status: interrupted ? "interrupted" : "failed", error: message });
      this.context.log({
        level: interrupted ? "warn" : "error",
        event: interrupted ? "session.run.interrupted" : "session.run.failed",
        traceId,
        sessionId,
        runId,
        error: message,
      });
      this.context.events.publishSince(before);
    }
  }
}
