import { errorMessage } from "./error-state"
import {
  acknowledgeOperation,
  beginOperation,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import {
  classifyPromptPlacement,
  removePendingPromptSubmission,
  updatePendingPromptSubmission,
} from "./pending-prompt-state"
import type {
  DesktopSessionRuntime,
  DesktopStoreContext,
  PendingPromptEdit,
  PendingPromptSubmission,
  PromptActions,
} from "./types"

interface PromptActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createPromptActions(context: PromptActionsContext): PromptActions {
  const { get, set } = context

  return {
    async sendMessage(content, options) {
      const prompt = content.trim()
      const sessionId = get().activeSessionId
      if (!prompt || !sessionId) return

      if (options?.commandLine) {
        await invokeCommand(sessionId, options.commandLine)
        return
      }

      const current = get()
      const runtime = getSessionRuntime(current, sessionId)
      const retry = Object.values(runtime.pendingPromptSubmissions).find(
        (submission) => submission.content === prompt && submission.phase === "failed"
      )
      const submission: PendingPromptSubmission = retry
        ? { ...retry, phase: "submitting", error: undefined }
        : {
            id: globalThis.crypto.randomUUID(),
            sessionId,
            content: prompt,
            createdAt: Date.now(),
            phase: "submitting",
            placement: classifyPromptPlacement(current.sessionView, runtime, sessionId),
          }

      replaceRuntime(sessionId, (currentRuntime) =>
        beginOperation(
          {
            ...currentRuntime,
            pendingPromptSubmissions: {
              ...currentRuntime.pendingPromptSubmissions,
              [submission.id]: submission,
            },
          },
          {
            id: submission.id,
            kind: "send-prompt",
            sessionId,
            startedAt: Date.now(),
          }
        )
      )

      try {
        await window.desktop.sessions.sendPrompt({
          id: submission.id,
          sessionId,
          content: prompt,
        })
        const keepLocalAcknowledgement = get().activeSessionId === sessionId
        replaceRuntime(sessionId, (currentRuntime) =>
          settleSubmittedPrompt(
            {
              ...currentRuntime,
              pendingPromptSubmissions: updatePendingPromptSubmission(
                currentRuntime.pendingPromptSubmissions,
                submission.id,
                (pendingSubmission) => ({
                  ...pendingSubmission,
                  phase: "accepted",
                  error: undefined,
                })
              ),
            },
            submission.id,
            keepLocalAcknowledgement
          )
        )
      } catch (error) {
        const message = errorMessage(error)
        const confirmed = promptSubmissionConfirmed(get(), sessionId, submission.id)
        replaceRuntime(sessionId, (currentRuntime) => {
          if (confirmed) return removeOperation(currentRuntime, submission.id)
          return failOperation(
            {
              ...currentRuntime,
              pendingPromptSubmissions: updatePendingPromptSubmission(
                currentRuntime.pendingPromptSubmissions,
                submission.id,
                (pendingSubmission) => ({ ...pendingSubmission, phase: "failed", error: message })
              ),
            },
            submission.id,
            message,
            Date.now()
          )
        })
        if (!confirmed) throw error
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
    },

    async editLatestMessage(sourceMessageId, content) {
      const prompt = content.trim()
      const sessionId = get().activeSessionId
      if (!prompt || !sourceMessageId || !sessionId) return

      const runtime = getSessionRuntime(get(), sessionId)
      const edit: PendingPromptEdit =
        runtime.pendingPromptEdit?.sourceMessageId === sourceMessageId &&
        runtime.pendingPromptEdit.content === prompt
          ? runtime.pendingPromptEdit
          : { id: globalThis.crypto.randomUUID(), sessionId, sourceMessageId, content: prompt }

      replaceRuntime(sessionId, (currentRuntime) =>
        beginOperation(
          { ...currentRuntime, pendingPromptEdit: edit },
          {
            id: edit.id,
            kind: "edit-prompt",
            sessionId,
            target: sourceMessageId,
            startedAt: Date.now(),
          }
        )
      )
      try {
        await window.desktop.sessions.editLatestPrompt({
          id: edit.id,
          sessionId,
          content: prompt,
          sourceMessageId,
        })
        replaceRuntime(sessionId, (currentRuntime) =>
          removeOperation(
            currentRuntime.pendingPromptEdit?.id === edit.id
              ? { ...currentRuntime, pendingPromptEdit: null }
              : currentRuntime,
            edit.id
          )
        )
      } catch (error) {
        const message = errorMessage(error)
        const confirmed = !getSessionRuntime(get(), sessionId).pendingPromptEdit
        replaceRuntime(sessionId, (currentRuntime) =>
          confirmed
            ? removeOperation(currentRuntime, edit.id)
            : failOperation(currentRuntime, edit.id, message, Date.now())
        )
        if (!confirmed) throw error
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
    },

    async interrupt() {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      const view = get().sessionView
      const expectedRunId =
        view?.session.id === sessionId
          ? (view.runs.find((run) => run.status === "running")?.id ??
            view.runs.find((run) => run.status === "pending")?.id)
          : undefined
      const operationId = globalThis.crypto.randomUUID()
      replaceRuntime(sessionId, (runtime) =>
        beginOperation(runtime, {
          id: operationId,
          kind: "interrupt-run",
          sessionId,
          target: expectedRunId,
          startedAt: Date.now(),
        })
      )
      try {
        await window.desktop.sessions.interrupt({
          sessionId,
          ...(expectedRunId ? { expectedRunId } : {}),
        })
        replaceRuntime(sessionId, (runtime) => removeOperation(runtime, operationId))
      } catch (error) {
        const message = errorMessage(error)
        const confirmed = !getSessionRuntime(get(), sessionId).operations[operationId]
        replaceRuntime(sessionId, (runtime) =>
          confirmed
            ? removeOperation(runtime, operationId)
            : failOperation(runtime, operationId, message, Date.now())
        )
      }
    },

    async replyPermission(permissionId, status, decision = "once") {
      const sessionId = get().activeSessionId
      if (!sessionId || !permissionId) return
      const operationId = `${sessionId}:${permissionId}`
      if (getSessionRuntime(get(), sessionId).operations[operationId]?.phase === "pending") return
      replaceRuntime(sessionId, (runtime) =>
        beginOperation(runtime, {
          id: operationId,
          kind: "reply-permission",
          sessionId,
          target: permissionId,
          startedAt: Date.now(),
        })
      )
      try {
        await window.desktop.sessions.replyPermission({ permissionId, status, decision })
        replaceRuntime(sessionId, (runtime) => removeOperation(runtime, operationId))
      } catch (error) {
        const message = errorMessage(error)
        const confirmed = !getSessionRuntime(get(), sessionId).operations[operationId]
        replaceRuntime(sessionId, (runtime) =>
          confirmed
            ? removeOperation(runtime, operationId)
            : failOperation(runtime, operationId, message, Date.now())
        )
      }
    },
  }

  async function invokeCommand(sessionId: string, line: string): Promise<void> {
    const operationId = globalThis.crypto.randomUUID()
    replaceRuntime(sessionId, (runtime) =>
      beginOperation(runtime, {
        id: operationId,
        kind: "invoke-command",
        sessionId,
        target: line,
        startedAt: Date.now(),
      })
    )
    try {
      await window.desktop.sessions.invokeCommand({ sessionId, line })
      replaceRuntime(sessionId, (runtime) => removeOperation(runtime, operationId))
    } catch (error) {
      const message = errorMessage(error)
      replaceRuntime(sessionId, (runtime) =>
        failOperation(runtime, operationId, message, Date.now())
      )
      throw error
    } finally {
      context.scheduleSelectedProjectGitRefresh(true)
    }
  }

  function replaceRuntime(
    sessionId: string,
    update: (runtime: DesktopSessionRuntime) => DesktopSessionRuntime
  ): void {
    set((state) => {
      const runtime = update(getSessionRuntime(state, sessionId))
      const next = {
        sessionRuntimes: { ...state.sessionRuntimes, [sessionId]: runtime },
      }
      return next
    })
  }
}

function getSessionRuntime(
  state: Pick<import("./types").DesktopSessionState, "sessionRuntimes">,
  sessionId: string
): DesktopSessionRuntime {
  return state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
}

function promptSubmissionConfirmed(
  state: Pick<import("./types").DesktopSessionState, "sessionRuntimes" | "sessionView">,
  sessionId: string,
  inputId: string
): boolean {
  return (
    !getSessionRuntime(state, sessionId).pendingPromptSubmissions[inputId] ||
    Boolean(
      state.sessionView?.session.id === sessionId &&
      state.sessionView.inputs.some((input) => input.id === inputId)
    )
  )
}

function settleSubmittedPrompt(
  runtime: DesktopSessionRuntime,
  submissionId: string,
  keepLocalAcknowledgement: boolean
): DesktopSessionRuntime {
  const acknowledged = acknowledgeOperation(runtime, submissionId, Date.now())
  if (keepLocalAcknowledgement) return acknowledged
  return removeOperation(
    {
      ...acknowledged,
      pendingPromptSubmissions: removePendingPromptSubmission(
        acknowledged.pendingPromptSubmissions,
        submissionId
      ),
    },
    submissionId
  )
}
