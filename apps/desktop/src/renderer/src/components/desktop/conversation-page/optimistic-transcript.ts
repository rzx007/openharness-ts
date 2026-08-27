import type { PendingPromptSubmission } from "@renderer/stores/desktop-session/types"
import type { DesktopSessionMessage, DesktopSessionPart } from "@shared/session-types"

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
    parts: [
      ...parts,
      ...optimistic.map<DesktopSessionPart>((submission) => ({
        id: `optimistic-part:${submission.id}`,
        sessionId: submission.sessionId,
        messageId: `optimistic-message:${submission.id}`,
        seq: 0,
        type: "text",
        status: "completed",
        text: submission.content,
        metadata: { optimistic: true },
        createdAt: submission.createdAt,
        updatedAt: submission.createdAt,
      })),
    ],
  }
}
