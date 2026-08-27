import type { DesktopSessionView } from "@shared/session-types"
import {
  reconcilePendingPromptSubmissions,
  reconcileQueuedPromptActions,
} from "./pending-prompt-state"
import type { DesktopOperation, DesktopSessionRuntime } from "./types"

export function acceptActiveSessionView(
  activeSessionId: string | null,
  current: DesktopSessionView | null,
  incoming: DesktopSessionView
): DesktopSessionView | null {
  if (activeSessionId !== incoming.session.id) return current
  if (current?.session.id === incoming.session.id && current.cursor > incoming.cursor)
    return current
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
          operation.sessionId !== view.session.id ||
          !operationConfirmedByView(operation, operationId, confirmedEntityIds, view)
      )
    ),
    pendingPromptSubmissions: reconcilePendingPromptSubmissions(
      runtime.pendingPromptSubmissions,
      view
    ),
    pendingPromptEdit:
      runtime.pendingPromptEdit && confirmedEntityIds.has(runtime.pendingPromptEdit.id)
        ? null
        : runtime.pendingPromptEdit,
    queuedPromptActions: reconcileQueuedPromptActions(runtime.queuedPromptActions, view),
  }
}

export function releaseAcknowledgedRuntime(runtime: DesktopSessionRuntime): DesktopSessionRuntime {
  return {
    ...runtime,
    operations: Object.fromEntries(
      Object.entries(runtime.operations).filter(
        ([, operation]) => operation.phase !== "acknowledged"
      )
    ),
    pendingPromptSubmissions: Object.fromEntries(
      Object.entries(runtime.pendingPromptSubmissions).filter(
        ([, submission]) => submission.phase !== "accepted"
      )
    ),
    queuedPromptActions: Object.fromEntries(
      Object.entries(runtime.queuedPromptActions).filter(
        ([, action]) => action.phase !== "acknowledged"
      )
    ),
  }
}

function operationConfirmedByView(
  operation: DesktopOperation,
  operationId: string,
  confirmedInputIds: Set<string>,
  view: DesktopSessionView
): boolean {
  switch (operation.kind) {
    case "create-session":
    case "open-session":
      return true
    case "send-prompt":
    case "edit-prompt":
      return confirmedInputIds.has(operationId)
    case "promote-prompt":
    case "cancel-prompt": {
      const run = view.runs.find((candidate) => candidate.id === operation.target)
      return Boolean(run && run.status !== "pending")
    }
    case "interrupt-run": {
      const run = view.runs.find((candidate) => candidate.id === operation.target)
      return Boolean(run && run.status !== "pending" && run.status !== "running")
    }
    case "reply-permission": {
      const permission = view.permissions.find((candidate) => candidate.id === operation.target)
      return Boolean(permission && permission.status !== "pending")
    }
    case "invoke-command":
    case "project-action":
      return false
  }
}
