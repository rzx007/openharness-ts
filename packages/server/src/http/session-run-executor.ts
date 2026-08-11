import type { SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import { RunInterruptedError, type SessionRunWorkContext } from "../run-coordinator.js";
import type { AgentPool } from "./agent-pool.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionTranscriptProjection } from "./transcript-projection.js";

export interface SessionRunExecutorContext {
  store: SessionStore;
  agentPool: AgentPool;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  transcriptProjection: Pick<SessionTranscriptProjection, "finalizeRunParts">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}

export interface ExecuteSessionRunInput {
  sessionId: string;
  inputId: string;
  runId: string;
}

/** Executes one admitted run through the framework-owned AgentRunHandle. */
export class SessionRunExecutor {
  constructor(private readonly context: SessionRunExecutorContext) {}

  async execute(input: ExecuteSessionRunInput, workContext: SessionRunWorkContext): Promise<void> {
    if (!this.context.agentPool.configured) return;
    const { sessionId, inputId, runId } = input;
    try {
      const session = this.context.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const admitted = this.context.store.getInput(inputId);
      if (!admitted) throw new Error(`Session input not found: ${inputId}`);
      const agent = await this.context.agentPool.acquire(
        session,
        this.context.store.listMessages(sessionId),
        this.context.store.listMessageParts(sessionId),
      );
      agent.setModel(session.model);
      const run = agent.submitMessage(admitted.content, {
        signal: workContext.signal,
        delivery: admitted.delivery,
        ids: {
          inputId,
          runId,
          traceId: this.context.traceIdForRun(runId),
        },
      });
      await workContext.registerHandle(run);
      await run.result;
    } catch (error) {
      await this.context.agentPool.close(sessionId);
      const current = this.context.store.getRun(runId);
      if (current && ["completed", "failed", "interrupted"].includes(current.status)) return;
      const message = error instanceof Error ? error.message : String(error);
      const traceId = this.context.traceIdForRun(runId);
      const interrupted = error instanceof RunInterruptedError || workContext.signal.aborted;
      const before = this.context.events.checkpoint();
      this.context.transcriptProjection.finalizeRunParts(
        sessionId,
        runId,
        interrupted ? "interrupted" : "failed",
      );
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
