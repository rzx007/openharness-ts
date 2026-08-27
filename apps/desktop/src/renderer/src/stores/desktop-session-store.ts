import { create } from "zustand"

import {
  applyBootstrapData,
  attachDesktopDaemonStatusEvents,
  createBootstrapActions,
  createInitialDaemonStatus,
} from "./desktop-session/bootstrap-actions"
import {
  formatSessionTitle,
  isPlaceholderTitle,
  isSessionPinned,
  resolveSessionWorkspace,
  sessionPermissionMode,
  sessionProvider,
  upsertProject,
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
import { acceptActiveSessionView } from "./desktop-session/session-view-state"
import { createProjectActions } from "./desktop-session/project-actions"
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
import type {
  CreateDesktopSessionInput,
  DesktopSessionView,
} from "@shared/session-types"

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

  async startNewConversation() {
    await window.desktop.sessions.close()
    clearPersistedActiveSessionId()
    set({
      activeSessionId: null,
      sessionView: null,
      selectedModel: get().defaultModel,
      selectedProvider: get().defaultProvider,
      selectedPermissionMode: get().defaultPermissionMode,
      openingSession: false,
      sending: false,
      sendingOperationId: null,
      error: null,
    })
  },

  async selectModel(model) {
    const previousModel = get().selectedModel
    const previousProvider = get().selectedProvider
    set({
      selectedModel: model.id,
      selectedProvider: model.providerName,
      defaultModel: model.id,
      defaultProvider: model.providerName,
      error: null,
    })
    try {
      const data = await window.desktop.sessions.setDefaultModel({
        model: model.id,
        provider: model.providerName,
      })
      set((state) =>
        applyBootstrapData(
          data,
          state.selectedProject,
          state.workspaceMode,
          model.id,
          model.providerName
        )
      )
    } catch (error) {
      set({
        selectedModel: previousModel,
        selectedProvider: previousProvider,
        defaultModel: previousModel,
        defaultProvider: previousProvider,
        error: errorMessage(error),
      })
    }
  },

  async selectPermissionMode(permissionMode) {
    const previous = get().selectedPermissionMode
    set({
      selectedPermissionMode: permissionMode,
      defaultPermissionMode: permissionMode,
      error: null,
    })
    try {
      const data = await window.desktop.sessions.setDefaultPermissionMode({ permissionMode })
      set((state) => ({
        ...applyBootstrapData(
          data,
          state.selectedProject,
          state.workspaceMode,
          state.selectedModel,
          state.selectedProvider
        ),
        selectedPermissionMode: data.defaultPermissionMode,
      }))
    } catch (error) {
      set({
        selectedPermissionMode: previous,
        defaultPermissionMode: previous,
        error: errorMessage(error),
      })
    }
  },

  async updateSessionModel(sessionId, model) {
    try {
      const session = await window.desktop.sessions.updateModel({
        sessionId,
        model: model.id,
        provider: model.providerName,
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedModel: state.activeSessionId === sessionId ? session.model : state.selectedModel,
        selectedProvider:
          state.activeSessionId === sessionId
            ? sessionProvider(session, model.providerName)
            : state.selectedProvider,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async updateSessionPermissionMode(sessionId, permissionMode) {
    try {
      const session = await window.desktop.sessions.updatePermissionMode({
        sessionId,
        permissionMode,
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedPermissionMode:
          state.activeSessionId === sessionId
            ? sessionPermissionMode(session)
            : state.selectedPermissionMode,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async openSession(sessionId) {
    if (!sessionId) return
    set((state) => {
      const switchingSessions = state.activeSessionId !== sessionId
      return {
        activeSessionId: sessionId,
        sessionView: null,
        openingSession: true,
        sending: switchingSessions ? false : state.sending,
        sendingOperationId: switchingSessions ? null : state.sendingOperationId,
        error: null,
      }
    })
    try {
      const view = await window.desktop.sessions.open(sessionId)
      if (get().activeSessionId !== sessionId) return
      const current = get().sessionView
      if (current?.session.id === sessionId && view.cursor < current.cursor) {
        set({ openingSession: false })
        return
      }
      writePersistedActiveSessionId(sessionId)
      const workspace = resolveSessionWorkspace(get().projects, view.session)
      set((state) => ({
        ...workspace,
        sessionView: view,
        pendingPromptSubmissions: reconcilePendingPromptSubmissions(
          state.pendingPromptSubmissions,
          view
        ),
        queuedPromptActions: reconcileQueuedPromptActions(state.queuedPromptActions, view),
        openingSession: false,
        selectedModel: view.session.model,
        selectedProvider: sessionProvider(view.session, state.defaultProvider),
        selectedPermissionMode: sessionPermissionMode(view.session, state.defaultPermissionMode),
        sessions:
          view.session.status === "archived"
            ? state.sessions.filter((session) => session.id !== view.session.id)
            : upsertSession(state.sessions, view.session),
        archivedSessions:
          view.session.status === "archived"
            ? upsertSession(state.archivedSessions, view.session)
            : state.archivedSessions,
      }))
      if (workspace.selectedProject) {
        try {
          const details = await window.desktop.sessions.inspectProject(
            workspace.selectedProject.path
          )
          if (get().activeSessionId !== sessionId) return
          set((state) => ({
            projects: upsertProject(state.projects, details.project),
            selectedProject: details.project,
            selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
            selectedProjectGitCheckedAt: Date.now(),
            branch: details.branch,
            branches: details.branches ?? [],
          }))
        } catch {
          if (get().activeSessionId === sessionId) {
            set({
              selectedProjectGit: false,
              selectedProjectGitCheckedAt: Date.now(),
              branch: null,
              branches: [],
            })
          }
        }
      }
    } catch (error) {
      if (get().activeSessionId === sessionId) {
        clearPersistedActiveSessionId()
        set({ openingSession: false, error: errorMessage(error) })
      }
    }
  },

  async startConversationFrom(session) {
    await window.desktop.sessions.close()
    clearPersistedActiveSessionId()
    const workspace = resolveSessionWorkspace(get().projects, session)
    set({
      activeSessionId: null,
      sessionView: null,
      openingSession: false,
      sending: false,
      sendingOperationId: null,
      ...workspace,
      selectedModel: session.model,
      selectedProvider: sessionProvider(session, get().defaultProvider),
      selectedPermissionMode: sessionPermissionMode(session, get().defaultPermissionMode),
      selectedProjectGit: false,
      selectedProjectGitCheckedAt: null,
      branch: null,
      branches: [],
      error: null,
    })
    if (workspace.selectedProject) await get().selectProject(workspace.selectedProject)
  },

  async forkSession(sessionId, options) {
    if (!sessionId) throw new Error("会话 ID 不能为空")
    try {
      const session = await window.desktop.sessions.fork({
        sessionId,
        ...(options?.beforeMessageId ? { beforeMessageId: options.beforeMessageId } : {}),
        ...(options?.afterMessageId ? { afterMessageId: options.afterMessageId } : {}),
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        archivedSessions: state.archivedSessions.filter((item) => item.id !== session.id),
        error: null,
      }))
      await get().openSession(session.id)
      return session
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async renameSession(sessionId, title) {
    const normalizedTitle = title.replace(/\s+/g, " ").trim()
    if (!normalizedTitle) return
    try {
      const session = await window.desktop.sessions.rename({ sessionId, title: normalizedTitle })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async togglePinSession(sessionId) {
    const existing = get().sessions.find((session) => session.id === sessionId)
    if (!existing) return
    try {
      const session = await window.desktop.sessions.setPinned({
        sessionId,
        pinned: !isSessionPinned(existing),
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async archiveSession(sessionId) {
    const existing = get().sessions.find((session) => session.id === sessionId)
    if (!existing) return
    try {
      const archived = await window.desktop.sessions.archive(sessionId)
      const isActive = get().activeSessionId === sessionId
      set((state) => ({
        ...(isActive ? resolveSessionWorkspace(state.projects, existing) : {}),
        sessions: state.sessions.filter((session) => session.id !== sessionId),
        archivedSessions: upsertSession(state.archivedSessions, archived),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView: isActive ? null : state.sessionView,
        pendingPromptSubmissions: filterPendingPromptSubmissions(
          state.pendingPromptSubmissions,
          (submission) => submission.sessionId !== sessionId
        ),
        queuedPromptActions: filterQueuedPromptActions(
          state.queuedPromptActions,
          (action) => action.sessionId !== sessionId
        ),
        openingSession: isActive ? false : state.openingSession,
        sending: isActive ? false : state.sending,
        sendingOperationId: isActive ? null : state.sendingOperationId,
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
        error: null,
      }))
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
      }
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async deleteSession(sessionId) {
    const existing =
      get().sessions.find((session) => session.id === sessionId) ??
      get().archivedSessions.find((session) => session.id === sessionId)
    if (!existing) return
    try {
      const deletedSessionIds = await window.desktop.sessions.delete(sessionId)
      const deleted = new Set(deletedSessionIds)
      const activeSessionId = get().activeSessionId
      const isActive = activeSessionId !== null && deleted.has(activeSessionId)
      set((state) => ({
        ...(isActive ? resolveSessionWorkspace(state.projects, existing) : {}),
        sessions: state.sessions.filter((session) => !deleted.has(session.id)),
        archivedSessions: state.archivedSessions.filter((session) => !deleted.has(session.id)),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView:
          state.sessionView && deleted.has(state.sessionView.session.id) ? null : state.sessionView,
        pendingPromptSubmissions: filterPendingPromptSubmissions(
          state.pendingPromptSubmissions,
          (submission) => !deleted.has(submission.sessionId)
        ),
        queuedPromptActions: filterQueuedPromptActions(
          state.queuedPromptActions,
          (action) => !deleted.has(action.sessionId)
        ),
        openingSession: isActive ? false : state.openingSession,
        sending: isActive ? false : state.sending,
        sendingOperationId: isActive ? null : state.sendingOperationId,
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
        error: null,
      }))
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
      }
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async startSession(content: string, options?: SubmitPromptOptions) {
    const prompt = content.trim()
    const {
      selectedProject,
      workspaceMode,
      selectedModel,
      selectedProvider,
      defaultModel,
      defaultProvider,
      selectedPermissionMode,
    } = get()
    const model = selectedModel ?? defaultModel
    const provider = selectedProvider ?? defaultProvider
    if (!prompt || get().sending) return null
    if (workspaceMode === "project" && !selectedProject) {
      set({ error: "请先选择一个项目目录。" })
      return null
    }
    if (!model) {
      set({ error: "没有可用模型，请先配置模型。" })
      return null
    }

    const promptSubmissionId = globalThis.crypto.randomUUID()
    let startedSessionId: string | null = null
    set({ sending: true, sendingOperationId: promptSubmissionId, error: null })
    try {
      const sessionInput: CreateDesktopSessionInput =
        workspaceMode === "project" && selectedProject
          ? {
              projectId: selectedProject.id,
              cwd: selectedProject.path,
              model,
              ...(provider ? { provider } : {}),
              permissionMode: selectedPermissionMode,
            }
          : {
              model,
              ...(provider ? { provider } : {}),
              permissionMode: selectedPermissionMode,
            }
      const session = await window.desktop.sessions.create(sessionInput)
      startedSessionId = session.id
      set((state) => {
        const ownsCurrentPage = state.sendingOperationId === promptSubmissionId
        return {
          sessions: upsertSession(state.sessions, session),
          ...(ownsCurrentPage
            ? {
                activeSessionId: session.id,
                openingSession: true,
              }
            : {}),
          ...(!options?.commandLine
            ? {
                pendingPromptSubmissions: {
                  ...state.pendingPromptSubmissions,
                  [promptSubmissionId]: {
                    id: promptSubmissionId,
                    sessionId: session.id,
                    content: prompt,
                    createdAt: Date.now(),
                    phase: "submitting",
                    placement: "transcript",
                  },
                },
              }
            : {}),
        }
      })
      if (get().sendingOperationId === promptSubmissionId) {
        writePersistedActiveSessionId(session.id)
        const view = await window.desktop.sessions.open(session.id)
        set((state) =>
          state.activeSessionId === session.id
            ? {
                sessionView: acceptActiveSessionView(state.activeSessionId, state.sessionView, view),
                pendingPromptSubmissions: reconcilePendingPromptSubmissions(
                  state.pendingPromptSubmissions,
                  view
                ),
                queuedPromptActions: reconcileQueuedPromptActions(state.queuedPromptActions, view),
                openingSession: false,
                selectedModel: view.session.model,
                selectedProvider: sessionProvider(view.session, provider),
                selectedPermissionMode: sessionPermissionMode(
                  view.session,
                  state.defaultPermissionMode
                ),
              }
            : state
        )
      }
      if (options?.commandLine) {
        await window.desktop.sessions.invokeCommand({
          sessionId: session.id,
          line: options.commandLine,
        })
      } else {
        await window.desktop.sessions.sendPrompt({
          id: promptSubmissionId,
          sessionId: session.id,
          content: prompt,
        })
        set((state) => ({
          pendingPromptSubmissions: updatePendingPromptSubmission(
            state.pendingPromptSubmissions,
            promptSubmissionId,
            (submission) => ({ ...submission, phase: "accepted", error: undefined })
          ),
        }))
      }
      const title = formatSessionTitle(prompt)
      set((state) => {
        if (!state.sessions.some((candidate) => candidate.id === session.id)) return state
        const titledSession = { ...session, title, updatedAt: Date.now() }
        return {
          sessions: upsertSession(state.sessions, titledSession),
          sessionView:
            state.sessionView?.session.id === session.id
              ? {
                  ...state.sessionView,
                  session: { ...state.sessionView.session, title },
                }
              : state.sessionView,
        }
      })
    } catch (error) {
      const message = errorMessage(error)
      const currentState = get()
      const confirmed =
        !options?.commandLine &&
        (!currentState.pendingPromptSubmissions[promptSubmissionId] ||
          sessionViewContainsInput(currentState.sessionView, promptSubmissionId))
      set((state) => ({
        openingSession: state.activeSessionId === startedSessionId ? false : state.openingSession,
        error: state.activeSessionId === startedSessionId && !confirmed ? message : state.error,
        pendingPromptSubmissions: confirmed
          ? removePendingPromptSubmission(state.pendingPromptSubmissions, promptSubmissionId)
          : updatePendingPromptSubmission(
              state.pendingPromptSubmissions,
              promptSubmissionId,
              (submission) => ({ ...submission, phase: "failed", error: message })
            ),
      }))
      if (confirmed) return startedSessionId
      throw error
    } finally {
      set((state) =>
        state.sendingOperationId === promptSubmissionId
          ? { sending: false, sendingOperationId: null }
          : state
      )
      scheduleSelectedProjectGitRefresh(true)
    }
    return startedSessionId
  },

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

function filterPendingPromptSubmissions(
  submissions: Record<string, PendingPromptSubmission>,
  keep: (submission: PendingPromptSubmission) => boolean
): Record<string, PendingPromptSubmission> {
  return Object.fromEntries(
    Object.entries(submissions).filter(([, submission]) => keep(submission))
  )
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

function filterQueuedPromptActions(
  actions: Record<string, QueuedPromptAction>,
  keep: (action: QueuedPromptAction) => boolean
): Record<string, QueuedPromptAction> {
  return Object.fromEntries(Object.entries(actions).filter(([, action]) => keep(action)))
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
