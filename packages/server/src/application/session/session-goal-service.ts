import { randomUUID } from "node:crypto";
import {
  DEFAULT_GOAL_AUTO_TURNS,
  type CreateSessionGoalInput,
  type GoalActionInput,
  type SessionGoal,
  type UpdateSessionGoalInput,
} from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";
import type { SessionApplicationService } from "./session-application-service.js";
import type { SessionRunEngine } from "./session-run-engine.js";
import { SessionApplicationError } from "./session-application-error.js";

export class SessionGoalService {
  constructor(private readonly context: {
    store: SessionStore;
    sessions: Pick<SessionApplicationService, "admitPrompt">;
    runEngine: Pick<SessionRunEngine, "interruptSession">;
  }) {}

  get(sessionId: string): SessionGoal | null {
    this.requireSession(sessionId);
    return this.context.store.getCurrentGoal(sessionId) ?? null;
  }

  async create(sessionId: string, input: CreateSessionGoalInput): Promise<SessionGoal> {
    this.requireSession(sessionId);
    const goal = this.context.store.createGoal({
      sessionId,
      objective: input.objective,
      maxAutoTurns: input.maxAutoTurns ?? DEFAULT_GOAL_AUTO_TURNS,
    });
    try {
      await this.context.sessions.admitPrompt(sessionId, {
        id: input.requestId,
        delivery: "queue",
        items: [{ type: "text", text: input.objective }],
        metadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: "initial" },
        runMetadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: "initial" },
      });
      return goal;
    } catch (error) {
      this.context.store.updateGoal(goal.id, {
        expectedRevision: goal.revision,
        status: "paused",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async update(sessionId: string, goalId: string, input: UpdateSessionGoalInput): Promise<SessionGoal> {
    const goal = this.requireGoal(sessionId, goalId);
    this.context.runEngine.interruptSession(sessionId, "Goal updated");
    const updated = this.context.store.updateGoal(goal.id, {
      expectedRevision: input.expectedRevision,
      objective: input.objective,
      status: "active",
      currentRunId: null,
      reason: null,
      wait: null,
    });
    return await this.createRevisionRun(updated, input.requestId, "edit");
  }

  action(sessionId: string, goalId: string, input: GoalActionInput): SessionGoal {
    const goal = this.requireGoal(sessionId, goalId);
    if (input.action === "pause" || input.action === "cancel") {
      this.context.runEngine.interruptSession(sessionId, `Goal ${input.action}d`);
    }
    return this.context.store.updateGoal(goal.id, {
      expectedRevision: input.expectedRevision,
      status: input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : "active",
      maxAutoTurns: goal.maxAutoTurns + (input.additionalAutoTurns ?? 0),
      reason: null,
      wait: null,
    });
  }

  private async createRevisionRun(goal: SessionGoal, requestId: string, kind: string): Promise<SessionGoal> {
    await this.context.sessions.admitPrompt(goal.sessionId, {
      id: requestId || randomUUID(),
      delivery: "queue",
      items: [{ type: "text", text: goal.objective }],
      metadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: kind },
      runMetadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: kind },
    });
    return goal;
  }

  private requireSession(sessionId: string): void {
    if (!this.context.store.getSession(sessionId)) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
  }

  private requireGoal(sessionId: string, goalId: string): SessionGoal {
    const goal = this.context.store.getGoal(goalId);
    if (!goal || goal.sessionId !== sessionId) throw new SessionApplicationError(404, `Goal not found: ${goalId}`);
    return goal;
  }
}
