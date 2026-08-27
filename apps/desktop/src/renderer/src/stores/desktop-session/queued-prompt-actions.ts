import { errorMessage } from "./error-state"
import {
  acknowledgeOperation,
  beginOperation,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import { queuedPromptActionConfirmed, queuedPromptActionKey } from "./pending-prompt-state"
import type {
  DesktopSessionRuntime,
  DesktopStoreContext,
  QueuedPromptAction,
  QueuedPromptActions,
} from "./types"

interface QueuedPromptActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createQueuedPromptActions(
  context: QueuedPromptActionsContext
): QueuedPromptActions {
  const { get, set } = context

  return {
    async promoteQueuedPrompt(inputId, queuedRunId, expectedActiveRunId) {
      const sessionId = get().activeSessionId
      if (!sessionId || !inputId || !queuedRunId || !expectedActiveRunId) return
      const action: QueuedPromptAction = {
        sessionId,
        inputId,
        runId: queuedRunId,
        kind: "promote",
        phase: "pending",
      }
      const actionKey = queuedPromptActionKey(sessionId, queuedRunId)
      if (getSessionRuntime(get(), sessionId).queuedPromptActions[actionKey]?.phase === "pending")
        return

      replaceRuntime(sessionId, actionKey, action, (runtime) =>
        beginOperation(
          {
            ...runtime,
            queuedPromptActions: { ...runtime.queuedPromptActions, [actionKey]: action },
          },
          {
            id: actionKey,
            kind: "promote-prompt",
            sessionId,
            target: queuedRunId,
            startedAt: Date.now(),
          }
        )
      )
      try {
        await window.desktop.sessions.promoteQueuedPrompt({
          sessionId,
          inputId,
          queuedRunId,
          expectedActiveRunId,
        })
        replaceRuntime(sessionId, actionKey, action, (runtime) =>
          settleAcknowledgedAction(runtime, actionKey, action, get().sessionView)
        )
      } catch (error) {
        const message = queuedPromptActionError("promote", error)
        const confirmed = queuedActionConfirmed(get(), sessionId, actionKey, action)
        replaceRuntime(
          sessionId,
          actionKey,
          action,
          (runtime) =>
            confirmed
              ? removeActionAndOperation(runtime, actionKey)
              : failAction(runtime, actionKey, message),
          confirmed ? undefined : message
        )
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
    },

    async cancelQueuedPrompt(inputId, queuedRunId) {
      const sessionId = get().activeSessionId
      if (!sessionId || !inputId || !queuedRunId) return
      const action: QueuedPromptAction = {
        sessionId,
        inputId,
        runId: queuedRunId,
        kind: "cancel",
        phase: "pending",
      }
      const actionKey = queuedPromptActionKey(sessionId, queuedRunId)
      if (getSessionRuntime(get(), sessionId).queuedPromptActions[actionKey]?.phase === "pending")
        return

      replaceRuntime(sessionId, actionKey, action, (runtime) =>
        beginOperation(
          {
            ...runtime,
            queuedPromptActions: { ...runtime.queuedPromptActions, [actionKey]: action },
          },
          {
            id: actionKey,
            kind: "cancel-prompt",
            sessionId,
            target: queuedRunId,
            startedAt: Date.now(),
          }
        )
      )
      try {
        await window.desktop.sessions.cancelQueuedPrompt({ sessionId, inputId, queuedRunId })
        replaceRuntime(sessionId, actionKey, action, (runtime) =>
          settleAcknowledgedAction(runtime, actionKey, action, get().sessionView)
        )
      } catch (error) {
        const message = queuedPromptActionError("cancel", error)
        const confirmed = queuedActionConfirmed(get(), sessionId, actionKey, action)
        replaceRuntime(
          sessionId,
          actionKey,
          action,
          (runtime) =>
            confirmed
              ? removeActionAndOperation(runtime, actionKey)
              : failAction(runtime, actionKey, message),
          confirmed ? undefined : message
        )
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
    },
  }

  function replaceRuntime(
    sessionId: string,
    _actionKey: string,
    _action: QueuedPromptAction,
    update: (runtime: DesktopSessionRuntime) => DesktopSessionRuntime,
    activeError?: string
  ): void {
    set((state) => {
      const runtime = update(getSessionRuntime(state, sessionId))
      const next = { sessionRuntimes: { ...state.sessionRuntimes, [sessionId]: runtime } }
      if (state.activeSessionId !== sessionId) return next
      return {
        ...next,
        queuedPromptActions: runtime.queuedPromptActions,
        error: activeError ?? null,
      }
    })
  }
}

function getSessionRuntime(
  state: Pick<import("./types").DesktopSessionState, "sessionRuntimes">,
  sessionId: string
): DesktopSessionRuntime {
  return state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
}

function settleAcknowledgedAction(
  runtime: DesktopSessionRuntime,
  actionKey: string,
  action: QueuedPromptAction,
  view: import("@shared/session-types").DesktopSessionView | null
): DesktopSessionRuntime {
  const current = runtime.queuedPromptActions[actionKey]
  if (!current || current.kind !== action.kind || current.inputId !== action.inputId) return runtime
  if (queuedPromptActionConfirmed(view, action)) return removeActionAndOperation(runtime, actionKey)
  return acknowledgeOperation(
    {
      ...runtime,
      queuedPromptActions: {
        ...runtime.queuedPromptActions,
        [actionKey]: { ...current, phase: "acknowledged", error: undefined },
      },
    },
    actionKey,
    Date.now()
  )
}

function queuedActionConfirmed(
  state: Pick<import("./types").DesktopSessionState, "sessionRuntimes" | "sessionView">,
  sessionId: string,
  actionKey: string,
  action: QueuedPromptAction
): boolean {
  return (
    !getSessionRuntime(state, sessionId).queuedPromptActions[actionKey] ||
    queuedPromptActionConfirmed(state.sessionView, action)
  )
}

function failAction(
  runtime: DesktopSessionRuntime,
  actionKey: string,
  error: string
): DesktopSessionRuntime {
  const action = runtime.queuedPromptActions[actionKey]
  if (!action) return runtime
  return failOperation(
    {
      ...runtime,
      queuedPromptActions: {
        ...runtime.queuedPromptActions,
        [actionKey]: { ...action, phase: "failed", error },
      },
    },
    actionKey,
    error,
    Date.now()
  )
}

function removeActionAndOperation(
  runtime: DesktopSessionRuntime,
  actionKey: string
): DesktopSessionRuntime {
  const actions = { ...runtime.queuedPromptActions }
  delete actions[actionKey]
  return removeOperation({ ...runtime, queuedPromptActions: actions }, actionKey)
}

function queuedPromptActionError(kind: "promote" | "cancel", error: unknown): string {
  const message = errorMessage(error)
  if (kind === "promote" && /active run|当前运行|target run|409/i.test(message)) {
    return "当前回答已经切换，这条消息仍保留在待处理队列中。"
  }
  return kind === "promote" ? `调整方向失败：${message}` : `删除失败：${message}`
}
