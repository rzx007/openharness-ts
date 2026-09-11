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
    const paused = this.context.store.updateGoal(goal.id, {
      expectedRevision: input.expectedRevision,
      status: "paused",
      reason: "正在更新目标",
    });
    this.context.runEngine.interruptSession(sessionId, "Goal updated");
    const updated = this.context.store.updateGoal(goal.id, {
      expectedRevision: paused.revision,
      objective: input.objective,
      status: "active",
      currentRunId: null,
      reason: null,
      wait: null,
    });
    return await this.createRevisionRun(updated, input.requestId, "edit");
  }

  async action(sessionId: string, goalId: string, input: GoalActionInput): Promise<SessionGoal> {
    const goal = this.requireGoal(sessionId, goalId);
    const updated = this.context.store.updateGoal(goal.id, {
      expectedRevision: input.expectedRevision,
      status: input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : "active",
      maxAutoTurns: goal.maxAutoTurns + (input.additionalAutoTurns ?? 0),
      reason: null,
      wait: null,
    });
    if (input.action === "pause" || input.action === "cancel") {
      this.context.runEngine.interruptSession(sessionId, `Goal ${input.action}d`);
    }
    return input.action === "resume"
      ? await this.createRevisionRun(updated, input.requestId, "resume")
      : updated;
  }

  async settleRun(sessionId: string, runId: string): Promise<void> {
    const run = this.context.store.getRun(runId);
    const goalId = typeof run?.metadata.goalId === "string" ? run.metadata.goalId : undefined;
    const runRevision = typeof run?.metadata.goalRevision === "number" ? run.metadata.goalRevision : undefined;
    if (!run || !goalId || runRevision === undefined) return;
    const goal = this.context.store.getGoal(goalId);
    if (!goal || goal.sessionId !== sessionId || goal.revision !== runRevision || goal.status !== "active") return;
    const assessment = run.metadata.goalAssessment;
    if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", reason: "目标回合没有提交有效评估" });
      return;
    }
    const value = assessment as Record<string, unknown>;
    const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item): item is string => typeof item === "string") : [];
    if (value.decision === "complete") {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "completed", evidence, reason: null });
      return;
    }
    if (value.decision === "waiting_user" || value.decision === "blocked") {
      this.context.store.updateGoal(goal.id, {
        expectedRevision: goal.revision,
        status: value.decision,
        evidence,
        reason: typeof value.reason === "string" ? value.reason : typeof value.nextStep === "string" ? value.nextStep : null,
      });
      return;
    }
    if (value.decision !== "continue") {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", reason: "目标评估结果无效" });
      return;
    }
    if (goal.autoTurnsUsed >= goal.maxAutoTurns) {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", reason: "目标自动续跑额度已用完" });
      return;
    }
    const continued = this.context.store.updateGoal(goal.id, {
      expectedRevision: goal.revision,
      autoTurnsUsed: goal.autoTurnsUsed + 1,
      evidence,
      reason: null,
    });
    await this.createRevisionRun(
      continued,
      `goal-${continued.id}-${continued.revision}-${runId}`,
      "continuation",
    );
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
