import { create } from "zustand"

import {
  attachDesktopDaemonStatusEvents,
  createBootstrapActions,
  createInitialDaemonStatus,
} from "./desktop-session/bootstrap-actions"
import {
  isPlaceholderTitle,
  sessionPermissionMode,
  sessionProvider,
  upsertSession,
} from "./desktop-session/helpers"
import { createInitialRuntimeState } from "./desktop-session/initial-state"
import {
  classifyPromptPlacement,
  queuedPromptActionConfirmed,
  queuedPromptActionKey,
  reconcilePendingPromptSubmissions,
  reconcileQueuedPromptActions,
  removePendingPromptSubmission,
  updatePendingPromptSubmission,
} from "./desktop-session/pending-prompt-state"
import {
  acceptActiveSessionView,
  reconcileRuntimeWithView,
} from "./desktop-session/session-view-state"
import { createProjectActions } from "./desktop-session/project-actions"
import { createSessionActions } from "./desktop-session/session-actions"
import {
  clearPersistedActiveSessionId,
  writePersistedActiveSessionId,
} from "./desktop-session/persistence"
import { errorMessage } from "./desktop-session/error-state"
import type {
  DesktopSessionState,
  PendingPromptEdit,
  PendingPromptSubmission,
  QueuedPromptAction,
  SubmitPromptOptions,
} from "./desktop-session/types"
import type { DesktopSessionView } from "@shared/session-types"

export type { QueuedPromptAction } from "./desktop-session/types"
export { isSessionPinned } from "./desktop-session/helpers"

const selectedProjectGitRefreshDelayMs = 750

let selectedProjectGitRefreshTimer: ReturnType<typeof setTimeout> | null = null

export const useDesktopSessionStore = create<DesktopSessionState>((set, get) => ({
  loadStatus: "idle",
  daemonStatus: createInitialDaemonStatus(),
  error: null,
  projects: [],
  sessions: [],
  archivedSessions: [],
  models: [],
  defaultModel: null,
  defaultProvider: null,
  defaultPermissionMode: "default",
  selectedModel: null,
  selectedProvider: null,
  selectedPermissionMode: "default",
  workspaceMode: "project",
  selectedProject: null,
  selectedProjectGit: false,
  selectedProjectGitCheckedAt: null,
  branch: null,
  branches: [],
  activeSessionId: null,
  sessionView: null,
  openingSession: false,
  sending: false,
  pendingPromptSubmissions: {},
  sendingOperationId: null,
  pendingPromptEdit: null,
  queuedPromptActions: {},
  ...createInitialRuntimeState(),
  ...createBootstrapActions({ set, get }),
  ...createProjectActions({ set, get }),

  ...createSessionActions({
    set,
    get,
    scheduleSelectedProjectGitRefresh,
  }),

  async sendMessage(content: string, options?: SubmitPromptOptions) {
    const prompt = content.trim()
    const sessionId = get().activeSessionId
    if (!prompt || !sessionId || get().sending) return
    if (options?.commandLine) {
      const operationId = globalThis.crypto.randomUUID()
      set({ sending: true, sendingOperationId: operationId, error: null })
      try {
        await window.desktop.sessions.invokeCommand({ sessionId, line: options.commandLine })
      } catch (error) {
        set((state) => ({
          error: state.activeSessionId === sessionId ? errorMessage(error) : state.error,
        }))
        throw error
      } finally {
        set((state) =>
          state.sendingOperationId === operationId
            ? { sending: false, sendingOperationId: null }
            : state
        )
        scheduleSelectedProjectGitRefresh(true)
      }
      return
    }
    const currentState = get()
    const pending = Object.values(currentState.pendingPromptSubmissions).find(
      (submission) =>
        submission.sessionId === sessionId &&
        submission.content === prompt &&
        submission.phase === "failed"
    )
    const placement = classifyPromptPlacement(
      currentState.sessionView,
      {
        operations: {},
        pendingPromptSubmissions: currentState.pendingPromptSubmissions,
        pendingPromptEdit: null,
        queuedPromptActions: currentState.queuedPromptActions,
      },
      sessionId
    )
    const submission: PendingPromptSubmission = pending
      ? { ...pending, phase: "submitting", error: undefined }
      : {
          id: globalThis.crypto.randomUUID(),
          sessionId,
          content: prompt,
          createdAt: Date.now(),
          phase: "submitting",
          placement,
        }
    set((state) => ({
      sending: true,
      sendingOperationId: submission.id,
      error: null,
      pendingPromptSubmissions: {
        ...state.pendingPromptSubmissions,
        [submission.id]: submission,
      },
    }))
    try {
      await window.desktop.sessions.sendPrompt({
        id: submission.id,
        sessionId,
        content: prompt,
      })
      set((state) => ({
        pendingPromptSubmissions: updatePendingPromptSubmission(
          state.pendingPromptSubmissions,
          submission.id,
          (pendingSubmission) => ({
            ...pendingSubmission,
            phase: "accepted",
            error: undefined,
          })
        ),
      }))
    } catch (error) {
      const message = errorMessage(error)
      const currentState = get()
      const confirmed =
        !currentState.pendingPromptSubmissions[submission.id] ||
        sessionViewContainsInput(currentState.sessionView, submission.id)
      set((state) => ({
        error: state.activeSessionId === sessionId && !confirmed ? message : state.error,
        pendingPromptSubmissions: confirmed
          ? removePendingPromptSubmission(state.pendingPromptSubmissions, submission.id)
          : updatePendingPromptSubmission(
              state.pendingPromptSubmissions,
              submission.id,
              (pendingSubmission) => ({ ...pendingSubmission, phase: "failed", error: message })
            ),
      }))
      if (confirmed) return
      throw error
    } finally {
      set((state) =>
        state.sendingOperationId === submission.id
          ? { sending: false, sendingOperationId: null }
          : state
      )
      scheduleSelectedProjectGitRefresh(true)
    }
  },

  async editLatestMessage(sourceMessageId, content) {
    const prompt = content.trim()
    const sessionId = get().activeSessionId
    if (!prompt || !sourceMessageId || !sessionId || get().sending) return
    const pending = get().pendingPromptEdit
    const edit: PendingPromptEdit =
      pending?.sessionId === sessionId &&
      pending.sourceMessageId === sourceMessageId &&
      pending.content === prompt
        ? pending
        : { id: crypto.randomUUID(), sessionId, sourceMessageId, content: prompt }
    set({ sending: true, sendingOperationId: edit.id, error: null, pendingPromptEdit: edit })
    try {
      await window.desktop.sessions.editLatestPrompt({
        id: edit.id,
        sessionId,
        content: prompt,
        sourceMessageId,
      })
      set((state) => ({
        pendingPromptEdit: state.pendingPromptEdit?.id === edit.id ? null : state.pendingPromptEdit,
      }))
    } catch (error) {
      set((state) => ({
        error: state.activeSessionId === sessionId ? errorMessage(error) : state.error,
      }))
      throw error
    } finally {
      set((state) =>
        state.sendingOperationId === edit.id ? { sending: false, sendingOperationId: null } : state
      )
      scheduleSelectedProjectGitRefresh(true)
    }
  },

  async promoteQueuedPrompt(inputId, queuedRunId, expectedActiveRunId) {
    const sessionId = get().activeSessionId
    if (!sessionId || !inputId || !queuedRunId || !expectedActiveRunId) return
    const actionKey = queuedPromptActionKey(sessionId, queuedRunId)
    if (get().queuedPromptActions[actionKey]?.phase === "pending") return
    const action: QueuedPromptAction = {
      sessionId,
      inputId,
      runId: queuedRunId,
      kind: "promote",
      phase: "pending",
    }
    set((state) => ({
      queuedPromptActions: { ...state.queuedPromptActions, [actionKey]: action },
      error: null,
    }))
    try {
      await window.desktop.sessions.promoteQueuedPrompt({
        sessionId,
        inputId,
        queuedRunId,
        expectedActiveRunId,
      })
      set((state) => ({
        queuedPromptActions: settleQueuedPromptAction(
          state.queuedPromptActions,
          actionKey,
          action,
          state.sessionView
        ),
      }))
    } catch (error) {
      const message = queuedPromptActionError("promote", error)
      set((state) => {
        const confirmed =
          !state.queuedPromptActions[actionKey] ||
          queuedPromptActionConfirmed(state.sessionView, action)
        return {
          queuedPromptActions: confirmed
            ? removeQueuedPromptAction(state.queuedPromptActions, actionKey)
            : {
                ...state.queuedPromptActions,
                [actionKey]: { ...action, phase: "failed", error: message },
              },
          error: state.activeSessionId === sessionId && !confirmed ? message : state.error,
        }
      })
    }
  },

  async cancelQueuedPrompt(inputId, queuedRunId) {
    const sessionId = get().activeSessionId
    if (!sessionId || !inputId || !queuedRunId) return
    const actionKey = queuedPromptActionKey(sessionId, queuedRunId)
    if (get().queuedPromptActions[actionKey]?.phase === "pending") return
    const action: QueuedPromptAction = {
      sessionId,
      inputId,
      runId: queuedRunId,
      kind: "cancel",
      phase: "pending",
    }
    set((state) => ({
      queuedPromptActions: { ...state.queuedPromptActions, [actionKey]: action },
      error: null,
    }))
    try {
      await window.desktop.sessions.cancelQueuedPrompt({ sessionId, inputId, queuedRunId })
      set((state) => ({
        queuedPromptActions: settleQueuedPromptAction(
          state.queuedPromptActions,
          actionKey,
          action,
          state.sessionView
        ),
      }))
    } catch (error) {
      const message = queuedPromptActionError("cancel", error)
      set((state) => {
        const confirmed =
          !state.queuedPromptActions[actionKey] ||
          queuedPromptActionConfirmed(state.sessionView, action)
        return {
          queuedPromptActions: confirmed
            ? removeQueuedPromptAction(state.queuedPromptActions, actionKey)
            : {
                ...state.queuedPromptActions,
                [actionKey]: { ...action, phase: "failed", error: message },
              },
          error: state.activeSessionId === sessionId && !confirmed ? message : state.error,
        }
      })
    }
  },

  async interrupt() {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    const visibleRuns = get().sessionView?.runs ?? []
    const expectedRunId =
      visibleRuns.find((run) => run.status === "running")?.id ??
      visibleRuns.find((run) => run.status === "pending")?.id
    try {
      await window.desktop.sessions.interrupt({
        sessionId,
        ...(expectedRunId ? { expectedRunId } : {}),
      })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async replyPermission(permissionId, status, decision = "once") {
    try {
      await window.desktop.sessions.replyPermission({ permissionId, status, decision })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  applySessionUpdate(view) {
    const current = get().sessionView
    if (acceptActiveSessionView(get().activeSessionId, current, view) !== view) return
    if (view.session.status === "archived") clearPersistedActiveSessionId()
    else writePersistedActiveSessionId(view.session.id)
    set((state) => {
      const knownSession = state.sessions.find((session) => session.id === view.session.id)
      const session =
        knownSession &&
        isPlaceholderTitle(view.session.title) &&
        !isPlaceholderTitle(knownSession.title)
          ? { ...view.session, title: knownSession.title }
          : view.session

      return {
        sessionView: { ...view, session },
        pendingPromptSubmissions: reconcilePendingPromptSubmissions(
          state.pendingPromptSubmissions,
          view
        ),
        queuedPromptActions: reconcileQueuedPromptActions(state.queuedPromptActions, view),
        ...(state.sessionRuntimes[view.session.id]
          ? {
              sessionRuntimes: {
                ...state.sessionRuntimes,
                [view.session.id]: reconcileRuntimeWithView(
                  state.sessionRuntimes[view.session.id],
                  view
                ),
              },
            }
          : {}),
        openingSession: false,
        selectedModel: session.model,
        selectedProvider: sessionProvider(session, state.defaultProvider),
        selectedPermissionMode: sessionPermissionMode(session, state.defaultPermissionMode),
        sessions:
          session.status === "archived"
            ? state.sessions.filter((item) => item.id !== session.id)
            : upsertSession(state.sessions, session),
        archivedSessions:
          session.status === "archived"
            ? upsertSession(state.archivedSessions, session)
            : state.archivedSessions,
      }
    })
    scheduleSelectedProjectGitRefresh(true)
  },

  clearError() {
    set({ error: null })
  },
}))

export function attachDesktopSessionEvents(): () => void {
  attachDesktopDaemonStatusEvents({
    set: useDesktopSessionStore.setState,
    get: useDesktopSessionStore.getState,
  })
  return window.desktop.sessions.onUpdated((view) => {
    useDesktopSessionStore.getState().applySessionUpdate(view)
  })
}

function sessionViewContainsInput(view: DesktopSessionView | null, inputId: string): boolean {
  return Boolean(view?.inputs.some((input) => input.id === inputId))
}

function settleQueuedPromptAction(
  actions: Record<string, QueuedPromptAction>,
  actionKey: string,
  expected: QueuedPromptAction,
  view: DesktopSessionView | null
): Record<string, QueuedPromptAction> {
  const current = actions[actionKey]
  if (!current || current.kind !== expected.kind || current.inputId !== expected.inputId) {
    return actions
  }
  if (view?.session.id === expected.sessionId) {
    const run = view.runs.find((candidate) => candidate.id === expected.runId)
    if (run && run.status !== "pending") {
      const remaining = { ...actions }
      delete remaining[actionKey]
      return remaining
    }
  }
  return {
    ...actions,
    [actionKey]: { ...current, phase: "acknowledged", error: undefined },
  }
}

function removeQueuedPromptAction(
  actions: Record<string, QueuedPromptAction>,
  actionKey: string
): Record<string, QueuedPromptAction> {
  if (!actions[actionKey]) return actions
  const remaining = { ...actions }
  delete remaining[actionKey]
  return remaining
}

function queuedPromptActionError(kind: "promote" | "cancel", error: unknown): string {
  const message = errorMessage(error)
  if (kind === "promote" && /active run|当前运行|target run|409/i.test(message)) {
    return "当前回答已经切换，这条消息仍保留在待处理队列中。"
  }
  return kind === "promote" ? `调整方向失败：${message}` : `删除失败：${message}`
}

function scheduleSelectedProjectGitRefresh(force: boolean): void {
  if (selectedProjectGitRefreshTimer) clearTimeout(selectedProjectGitRefreshTimer)
  selectedProjectGitRefreshTimer = setTimeout(() => {
    selectedProjectGitRefreshTimer = null
    void useDesktopSessionStore.getState().refreshSelectedProjectGit({ force })
  }, selectedProjectGitRefreshDelayMs)
}
