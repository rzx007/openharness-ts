import type { SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import type { StorePermissionBroker } from "../permission-broker.js";
import { RunInterruptedError, type SessionRunWorkContext } from "../run-coordinator.js";
import type { ChildAgentProjectionFactory } from "./child-agent-projection-factory.js";
import { DaemonRunProjection } from "./session-run-projection.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { AgentPool } from "./agent-pool.js";
import type { SessionTranscriptProjection } from "./transcript-projection.js";

export interface SessionRunExecutorContext {
  store: SessionStore;
  agentPool: AgentPool;
  childAgentProjectionFactory: ChildAgentProjectionFactory;
  permissionBroker: Pick<StorePermissionBroker, "ask">;
  transcriptProjection: SessionTranscriptProjection;
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
    if (!this.context.agentPool.configured) return;
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
        transcriptProjection: this.context.transcriptProjection,
        events: this.context.events,
        sessionId,
        inputId,
        runId,
        traceId,
        signal: workContext.signal,
        log: this.context.log,
      });
      projection.start(admitted.content);

      const agent = await this.context.agentPool.acquire(session, history, parts);
      const scope = {
        sessionId,
        inputId,
        runId,
        cwd: session.cwd,
        traceId,
        signal: workContext.signal,
      };
      const childProjection = this.context.childAgentProjectionFactory.create({ scope, session });
      const host = projection.createHost(scope);
      agent.setModel(session.model);
      let lastWake = 0;
      for await (const _event of agent.submitMessage(admitted.content, {
        signal: workContext.signal,
        host,
        childProjection,
        pullFollowUps: () => {
          if (workContext.wakeCount() <= lastWake) return [];
          lastWake = workContext.wakeCount();
          return projection!.drainSteeredInputs().map((row) => row.content);
        },
      })) {
        if (workContext.signal.aborted) throw new Error("Run interrupted");
      }
      if (workContext.signal.aborted) throw new Error("Run interrupted");

      projection.complete(workContext.signal.aborted);
    } catch (error) {
      await this.context.agentPool.close(sessionId);
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
