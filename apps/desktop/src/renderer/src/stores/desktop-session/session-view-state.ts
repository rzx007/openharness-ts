import type { DesktopSessionView } from "@shared/session-types"
import { reconcilePendingPromptSubmissions, reconcileQueuedPromptActions } from "./pending-prompt-state"
import type { DesktopSessionRuntime } from "./types"

export function acceptActiveSessionView(
  activeSessionId: string | null,
  current: DesktopSessionView | null,
  incoming: DesktopSessionView
): DesktopSessionView | null {
  if (activeSessionId !== incoming.session.id) return current
  if (current?.session.id === incoming.session.id && current.cursor > incoming.cursor) return current
  return incoming
}

export function reconcileRuntimeWithView(
  runtime: DesktopSessionRuntime,
  view: DesktopSessionView
): DesktopSessionRuntime {
  const confirmedEntityIds = new Set([
    ...view.inputs.map((input) => input.id),
    ...view.runs.map((run) => run.id),
  ])
  return {
    ...runtime,
    operations: Object.fromEntries(
      Object.entries(runtime.operations).filter(
        ([operationId, operation]) =>
          operation.sessionId !== view.session.id || !confirmedEntityIds.has(operationId)
      )
    ),
    pendingPromptSubmissions: reconcilePendingPromptSubmissions(
      runtime.pendingPromptSubmissions,
      view
    ),
    queuedPromptActions: reconcileQueuedPromptActions(runtime.queuedPromptActions, view),
  }
}
