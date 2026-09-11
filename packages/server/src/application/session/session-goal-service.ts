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
    runEngine: Pick<SessionRunEngine, "interruptSession" | "activeRunId">;
    recoverOnStart?: boolean;
  }) {
    if (this.context.recoverOnStart !== false) this.context.store.pauseActiveGoalsOnStartup();
  }

  get(sessionId: string): SessionGoal | null {
    this.requireSession(sessionId);
    return this.context.store.getCurrentGoal(sessionId) ?? null;
  }

  getRequest(sessionId: string, requestId: string) {
    this.requireSession(sessionId);
    const request = this.context.store.getGoalRequest(requestId);
    if (!request || request.sessionId !== sessionId) throw new SessionApplicationError(404, `Goal request not found: ${requestId}`);
    return request;
  }

  async create(sessionId: string, input: CreateSessionGoalInput): Promise<SessionGoal> {
    this.requireSession(sessionId);
    const fingerprint = JSON.stringify({ operation: "create", objective: input.objective, maxAutoTurns: input.maxAutoTurns ?? DEFAULT_GOAL_AUTO_TURNS, items: input.items ?? [], attachments: input.attachments ?? [] });
    const request = this.context.store.beginGoalRequest({ requestId: input.requestId, sessionId, fingerprint });
    if (request.goalId) {
      const existing = this.context.store.getGoal(request.goalId);
      if (existing) return existing;
    }
    const goal = this.context.store.createGoal({
      sessionId,
      objective: input.objective,
      maxAutoTurns: input.maxAutoTurns ?? DEFAULT_GOAL_AUTO_TURNS,
    });
    this.context.store.settleGoalRequest(input.requestId, { status: "pending", goalId: goal.id });
    try {
      await this.context.sessions.admitPrompt(sessionId, {
        id: input.requestId,
        delivery: "queue",
        items: input.items?.length ? input.items : [{ type: "text", text: input.objective }],
        attachments: input.attachments,
        metadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: "initial" },
        runMetadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: "initial" },
      });
      this.context.store.settleGoalRequest(input.requestId, { status: "completed", goalId: goal.id, result: { goalId: goal.id } });
      return goal;
    } catch (error) {
      this.context.store.updateGoal(goal.id, {
        expectedRevision: goal.revision,
        status: "paused",
        reason: error instanceof Error ? error.message : String(error),
      });
      this.context.store.settleGoalRequest(input.requestId, { status: "failed", goalId: goal.id, error: error instanceof Error ? error.message : String(error) });
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
    this.interruptGoalRun(sessionId, goal.id, "Goal updated");
    const updated = this.context.store.updateGoal(goal.id, {
      expectedRevision: paused.revision,
      objective: input.objective,
      status: "active",
      currentRunId: null,
      reason: null,
      wait: null,
    });
    return await this.createRevisionRun(updated, input.requestId, "edit", input.items, input.attachments);
  }

  async action(sessionId: string, goalId: string, input: GoalActionInput): Promise<SessionGoal> {
    const goal = this.requireGoal(sessionId, goalId);
    if (input.action === "resume") {
      if (goal.status !== "paused") throw new SessionApplicationError(409, `Goal cannot resume from ${goal.status}`);
      if (goal.autoTurnsUsed >= goal.maxAutoTurns && !input.additionalAutoTurns) {
        throw new SessionApplicationError(409, "Goal resume requires additional auto turns");
      }
    }
    const updated = this.context.store.updateGoal(goal.id, {
      expectedRevision: input.expectedRevision,
      status: input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : "active",
      maxAutoTurns: goal.maxAutoTurns + (input.additionalAutoTurns ?? 0),
      reason: null,
      wait: null,
    });
    if (input.action === "pause" || input.action === "cancel") {
      this.interruptGoalRun(sessionId, goal.id, `Goal ${input.action}d`);
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
    this.context.store.recordGoalAssessment({ goalId: goal.id, revision: goal.revision, runId, assessment: value });
    const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item): item is string => typeof item === "string") : [];
    if (value.decision === "complete") {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "waiting_user", evidence, reason: "请确认目标是否已经完成", wait: { kind: "user", questionId: `goal-complete-${runId}`, question: "现有证据是否足以确认目标完成？" } });
      return;
    }
    if (value.decision === "waiting_user" || value.decision === "blocked") {
      this.context.store.updateGoal(goal.id, {
        expectedRevision: goal.revision,
        status: value.decision,
        evidence,
        reason: typeof value.reason === "string" ? value.reason : typeof value.nextStep === "string" ? value.nextStep : null,
        ...(value.decision === "waiting_user" ? { wait: { kind: "user" as const, questionId: `goal-question-${runId}`, question: typeof value.question === "string" ? value.question : "目标需要你的进一步说明。" } } : {}),
      });
      return;
    }
    if (value.decision !== "continue") {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", reason: "目标评估结果无效" });
      return;
    }
    const nextNoProgressCount = evidence.length === 0 ? goal.noProgressCount + 1 : 0;
    if (nextNoProgressCount >= 3) {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "blocked", noProgressCount: nextNoProgressCount, reason: "连续三个回合没有产生可验证进展" });
      return;
    }
    if (goal.autoTurnsUsed >= goal.maxAutoTurns) {
      this.context.store.updateGoal(goal.id, { expectedRevision: goal.revision, status: "paused", reason: "目标自动续跑额度已用完" });
      return;
    }
    const continued = this.context.store.updateGoal(goal.id, {
      expectedRevision: goal.revision,
      autoTurnsUsed: goal.autoTurnsUsed + 1,
      noProgressCount: nextNoProgressCount,
      evidence,
      reason: null,
    });
    if (!this.context.store.recordGoalContinuation({ goalId: continued.id, revision: continued.revision, previousRunId: runId })) return;
    try {
      await this.createRevisionRun(continued, `goal-${continued.id}-${continued.revision}-${runId}`, "continuation");
    } catch (error) {
      this.context.store.updateGoal(continued.id, {
        expectedRevision: continued.revision,
        status: "paused",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async createRevisionRun(goal: SessionGoal, requestId: string, kind: string, items?: import("@openharness/protocol").SessionUserInputItem[], attachments?: import("@openharness/protocol").AdmitPromptAttachmentInput[]): Promise<SessionGoal> {
    await this.context.sessions.admitPrompt(goal.sessionId, {
      id: requestId || randomUUID(),
      delivery: "queue",
      items: items?.length ? items : [{ type: "text", text: goal.objective }],
      attachments,
      metadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: kind },
      runMetadata: { goalId: goal.id, goalRevision: goal.revision, goalRunKind: kind },
    });
    return goal;
  }

  private requireSession(sessionId: string): void {
    if (!this.context.store.getSession(sessionId)) throw new SessionApplicationError(404, `Session not found: ${sessionId}`);
  }

  private interruptGoalRun(sessionId: string, goalId: string, reason: string): void {
    const activeRunId = this.context.runEngine.activeRunId(sessionId);
    if (!activeRunId) return;
    const run = this.context.store.getRun(activeRunId);
    if (run?.metadata.goalId === goalId) this.context.runEngine.interruptSession(sessionId, reason);
  }

  private requireGoal(sessionId: string, goalId: string): SessionGoal {
    const goal = this.context.store.getGoal(goalId);
    if (!goal || goal.sessionId !== sessionId) throw new SessionApplicationError(404, `Goal not found: ${goalId}`);
    return goal;
  }
}
