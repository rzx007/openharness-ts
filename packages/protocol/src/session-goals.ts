export type GoalStatus =
  | "active"
  | "waiting_user"
  | "blocked"
  | "paused"
  | "completed"
  | "cancelled"

export type GoalAction = "pause" | "resume" | "cancel"

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
    ...(Array.isArray(record.items) ? { items: record.items as SessionUserInputItem[] } : {}),
    ...(Array.isArray(record.attachments) ? { attachments: record.attachments as AdmitPromptAttachmentInput[] } : {}),
  }
}

export function parseUpdateSessionGoalInput(value: unknown): UpdateSessionGoalInput {
  const record = goalRecord(value)
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
    objective: requiredGoalString(record.objective, "objective", MAX_GOAL_OBJECTIVE_CHARS),
    ...(Array.isArray(record.items) ? { items: record.items as SessionUserInputItem[] } : {}),
    ...(Array.isArray(record.attachments) ? { attachments: record.attachments as AdmitPromptAttachmentInput[] } : {}),
  }
}

export function parseGoalActionInput(value: unknown): GoalActionInput {
  const record = goalRecord(value)
  if (record.action !== "pause" && record.action !== "resume" && record.action !== "cancel") {
    throw new Error("invalid_goal_action")
  }
  return {
    requestId: requiredGoalString(record.requestId, "requestId", 128),
    expectedRevision: goalNonNegativeInteger(record.expectedRevision, "expectedRevision"),
    action: record.action,
    ...(record.additionalAutoTurns === undefined
      ? {}
      : { additionalAutoTurns: goalPositiveInteger(record.additionalAutoTurns, "additionalAutoTurns") }),
  }
}

function goalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_goal_input")
  return value as Record<string, unknown>
}

function requiredGoalString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid_goal_${field}`)
  const normalized = value.trim()
  if (normalized.length > max) throw new Error(`goal_${field}_limit_exceeded`)
  return normalized
}

function goalNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`invalid_goal_${field}`)
  return value as number
}

function goalPositiveInteger(value: unknown, field: string): number {
  const integer = goalNonNegativeInteger(value, field)
  if (integer < 1 || integer > MAX_GOAL_AUTO_TURNS) throw new Error(`invalid_goal_${field}`)
  return integer
}
import type { AdmitPromptAttachmentInput } from "./attachment.js"
import type { SessionUserInputItem } from "./session-input-items.js"
