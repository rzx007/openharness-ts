import type { PendingPromptSubmission } from "@renderer/stores/desktop-session/types"
import type {
  DesktopSessionInput,
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

export function derivePendingHandoffSubmission(
  messages: DesktopSessionMessage[],
  inputs: DesktopSessionInput[],
  runs: DesktopSessionRun[],
  excludedRunIds: ReadonlySet<string> = new Set()
): PendingPromptSubmission | undefined {
  if (runs.some((run) => run.status === "running")) return undefined

  const nextRun = runs
    .filter((run) => run.status === "pending" && run.inputId && !excludedRunIds.has(run.id))
    .sort((left, right) => left.createdAt - right.createdAt)[0]
  if (!nextRun?.inputId) return undefined
  if (messages.some((message) => message.role === "user" && message.inputId === nextRun.inputId)) {
    return undefined
  }

  const input = inputs.find((candidate) => candidate.id === nextRun.inputId)
  if (!input) return undefined
  return {
    id: input.id,
    sessionId: input.sessionId,
    content: input.content,
    ...(readSkillInvocation(input.metadata)
      ? {
          skillInvocation: readSkillInvocation(input.metadata),
        }
      : {}),
    attachments: [...input.attachments]
      .sort((left, right) => left.seq - right.seq)
      .map(({ assetId, intent, displayName, mediaType, sizeBytes }) => ({
        assetId,
        intent,
        displayName,
        mediaType,
        sizeBytes,
      })),
    createdAt: input.createdAt,
    phase: "accepted",
    placement: "transcript",
  }
}

export function mergeOptimisticTranscript(
  messages: DesktopSessionMessage[],
  parts: DesktopSessionPart[],
  submissions: PendingPromptSubmission[]
): { messages: DesktopSessionMessage[]; parts: DesktopSessionPart[] } {
  const authoritativeInputIds = new Set(
    messages.flatMap((message) =>
      message.role === "user" && message.inputId ? [message.inputId] : []
    )
  )
  const optimistic = submissions.filter(
    (submission) =>
      submission.placement === "transcript" &&
      submission.phase !== "failed" &&
      !authoritativeInputIds.has(submission.id)
  )

  return {
    messages: [
      ...messages,
      ...optimistic.map<DesktopSessionMessage>((submission) => ({
        id: `optimistic-message:${submission.id}`,
        sessionId: submission.sessionId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        inputId: submission.id,
        metadata: { optimistic: true },
        createdAt: submission.createdAt,
        updatedAt: submission.createdAt,
      })),
    ],
    parts: [...parts, ...optimistic.flatMap(optimisticParts)],
  }
}

function optimisticParts(submission: PendingPromptSubmission): DesktopSessionPart[] {
  const messageId = `optimistic-message:${submission.id}`
  const textParts: DesktopSessionPart[] =
    submission.content || submission.skillInvocation
      ? [
          {
            id: `optimistic-part:${submission.id}`,
            sessionId: submission.sessionId,
            messageId,
            seq: 0,
            type: "text",
            status: "completed",
            text: submission.content,
            metadata: {
              optimistic: true,
              ...(submission.skillInvocation
                ? { skillInvocation: submission.skillInvocation }
                : {}),
            },
            createdAt: submission.createdAt,
            updatedAt: submission.createdAt,
          },
        ]
      : []
  const offset = textParts.length
  return [
    ...textParts,
    ...submission.attachments.map<DesktopSessionPart>((attachment, index) => {
      const seq = offset + index
      return {
        id: `optimistic-attachment:${submission.id}:${attachment.assetId}:${seq}`,
        sessionId: submission.sessionId,
        messageId,
        seq,
        type: "attachment",
        status: "completed",
        assetId: attachment.assetId,
        intent: attachment.intent,
        displayName: attachment.displayName,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        metadata: { optimistic: true },
        createdAt: submission.createdAt,
        updatedAt: submission.createdAt,
      }
    }),
  ]
}

function readSkillInvocation(
  metadata: Record<string, unknown>
): PendingPromptSubmission["skillInvocation"] {
  const value = metadata.skillInvocation
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.invocationSource !== "slash" || typeof record.name !== "string") return undefined
  const name = record.name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)) return undefined
  const source = record.source
  return {
    name,
    invocationSource: "slash",
    ...(typeof record.commandName === "string" ? { commandName: record.commandName } : {}),
    ...(typeof record.displayName === "string" ? { displayName: record.displayName } : {}),
    ...(source === "bundled" || source === "user" || source === "project" || source === "plugin"
      ? { source }
      : {}),
  }
}
