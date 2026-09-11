import type { AdmitPromptAttachmentInput } from "./session.js"
import type { SessionUserInputItem } from "./session-input-items.js"
import { parsePromptAttachments, parseSessionInputItems, ProtocolValidationError } from "./requests.js"

export type GoalStatus =
  | "active"
  | "waiting_user"
  | "blocked"
  | "paused"
  | "completed"
  | "cancelled"

export type GoalAction = "pause" | "resume" | "cancel" | "confirm"

export type GoalWait =
  | { kind: "user"; questionId: string; question: string; replyInputId?: string }
  | { kind: "approval"; permissionRequestId: string }
  | { kind: "external"; handleId: string; runId: string; deadlineAt: number }

export interface GoalEvidenceRef {
  goalId: string
  revision: number
  runId: string
  messagePartId: string
  criterion: string
}

export interface SessionGoal {
  id: string
  sessionId: string
  objective: string
  revision: number
  status: GoalStatus
  maxAutoTurns: number
  autoTurnsUsed: number
  noProgressCount: number
  currentRunId?: string
  reason?: string
  wait?: GoalWait
  evidence: string[]
  createdAt: number
  updatedAt: number
}

export interface CreateSessionGoalInput {
  requestId: string
  objective: string
  maxAutoTurns?: number
  items?: SessionUserInputItem[]
  attachments?: AdmitPromptAttachmentInput[]
}

export interface UpdateSessionGoalInput {
  requestId: string
  expectedRevision: number
  objective: string
  items?: SessionUserInputItem[]
  attachments?: AdmitPromptAttachmentInput[]
}

export interface GoalActionInput {
  requestId: string
  expectedRevision: number
  action: GoalAction
  additionalAutoTurns?: number
  questionId?: string
  response?: string
}

export interface GoalAssessment {
  goalId: string
  revision: number
  runId: string
  decision: "continue" | "complete" | "waiting_user" | "blocked"
  progress: string
  evidence: string[]
  evidenceRefs: GoalEvidenceRef[]
  nextStep?: string
  reason?: string
  wait?: GoalWait
}

export const DEFAULT_GOAL_AUTO_TURNS = 20
export const MAX_GOAL_AUTO_TURNS = 1_000
export const MAX_GOAL_OBJECTIVE_CHARS = 32_000

export function parseCreateSessionGoalInput(value: unknown): CreateSessionGoalInput {
  const record = goalRecord(value)
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    objective: requiredGoalString(record.objective, "objective", MAX_GOAL_OBJECTIVE_CHARS),
    ...(record.maxAutoTurns === undefined
      ? {}
      : { maxAutoTurns: goalPositiveInteger(record.maxAutoTurns, "maxAutoTurns") }),
    ...parseGoalContent(record),
  }
}

export function parseUpdateSessionGoalInput(value: unknown): UpdateSessionGoalInput {
  const record = goalRecord(value)
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
    objective: requiredGoalString(record.objective, "objective", MAX_GOAL_OBJECTIVE_CHARS),
    ...parseGoalContent(record),
  }
}

export function parseGoalActionInput(value: unknown): GoalActionInput {
  const record = goalRecord(value)
  if (record.action !== "pause" && record.action !== "resume" && record.action !== "cancel" && record.action !== "confirm") {
    throw new ProtocolValidationError("invalid_goal_action", "action")
  }
  if (record.action !== "resume" && (record.additionalAutoTurns !== undefined || record.response !== undefined)) {
    throw new ProtocolValidationError("Only resume accepts additionalAutoTurns or response", "action")
  }
  if (record.action === "confirm") requiredGoalString(record.questionId, "questionId", 256)
  if ((record.action === "pause" || record.action === "cancel") && record.questionId !== undefined) {
    throw new ProtocolValidationError("This action does not answer a question", "questionId")
  }
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
    action: record.action,
    ...(record.questionId === undefined ? {} : { questionId: requiredGoalString(record.questionId, "questionId", 256) }),
    ...(record.response === undefined ? {} : { response: requiredGoalString(record.response, "response", MAX_GOAL_OBJECTIVE_CHARS) }),
    ...(record.additionalAutoTurns === undefined
      ? {}
      : { additionalAutoTurns: goalPositiveInteger(record.additionalAutoTurns, "additionalAutoTurns") }),
  }
}

function goalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolValidationError("invalid_goal_input", "goal")
  return value as Record<string, unknown>
}

function requiredGoalString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new ProtocolValidationError(`invalid_goal_${field}`, field)
  const normalized = value.trim()
  if (normalized.length > max) throw new ProtocolValidationError(`goal_${field}_limit_exceeded`, field)
  return normalized
}

function goalNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProtocolValidationError(`invalid_goal_${field}`, field)
  return value as number
}

function goalPositiveInteger(value: unknown, field: string): number {
  const integer = goalNonNegativeInteger(value, field)
  if (integer < 1 || integer > MAX_GOAL_AUTO_TURNS) throw new ProtocolValidationError(`invalid_goal_${field}`, field)
  return integer
}
function parseGoalContent(record: Record<string, unknown>): Pick<CreateSessionGoalInput, "items" | "attachments"> {
  return {
    ...(record.items === undefined ? {} : { items: parseSessionInputItems(record.items) }),
    ...(record.attachments === undefined ? {} : { attachments: parsePromptAttachments(record.attachments) }),
  }
}

/** The caller supplies the trusted run identity; model input never sets it. */
export function parseGoalAssessment(value: unknown, binding: Pick<GoalAssessment, "goalId" | "revision" | "runId">): GoalAssessment {
  const record = goalRecord(value)
  const decision = record.decision
  if (decision !== "continue" && decision !== "complete" && decision !== "waiting_user" && decision !== "blocked") {
    throw new ProtocolValidationError("invalid_goal_decision", "decision")
  }
  if (!Array.isArray(record.evidence) || record.evidence.length > 32) throw new ProtocolValidationError("invalid_goal_evidence", "evidence")
  const refs = record.evidenceRefs ?? []
  if (!Array.isArray(refs) || refs.length > 32) throw new ProtocolValidationError("invalid_goal_evidence_refs", "evidenceRefs")
  const savedWait = record.wait && typeof record.wait === "object" && !Array.isArray(record.wait)
    ? record.wait as Record<string, unknown> : undefined
  const questionValue = record.question ?? (savedWait?.kind === "user" ? savedWait.question : undefined)
  const question = questionValue === undefined ? undefined : requiredGoalString(questionValue, "question", 4000)
  return {
    ...binding,
    decision,
    progress: requiredGoalString(record.progress, "progress", 4000),
    evidence: record.evidence.map((text) => requiredGoalString(text, "evidence", 4000)),
    evidenceRefs: refs.map((value) => {
      const ref = goalRecord(value)
      return { ...binding, messagePartId: requiredGoalString(ref.messagePartId, "messagePartId", 256), criterion: requiredGoalString(ref.criterion, "criterion", 4000) }
    }),
    ...(record.nextStep === undefined ? {} : { nextStep: requiredGoalString(record.nextStep, "nextStep", 4000) }),
    ...(record.reason === undefined ? {} : { reason: requiredGoalString(record.reason, "reason", 4000) }),
    ...(decision === "waiting_user" ? { wait: { kind: "user" as const, questionId: `goal-question-${binding.runId}`, question: question ?? "请补充继续目标所需的信息。" } } : {}),
  }
}
