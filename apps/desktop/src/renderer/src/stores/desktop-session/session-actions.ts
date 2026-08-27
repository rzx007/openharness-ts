import type { CreateDesktopSessionInput, DesktopSessionView } from "@shared/session-types"

import { applyBootstrapData } from "./bootstrap-actions"
import { errorMessage } from "./error-state"
import {
  formatSessionTitle,
  isSessionPinned,
  resolveSessionWorkspace,
  sessionPermissionMode,
  sessionProvider,
  upsertProject,
  upsertSession,
} from "./helpers"
import {
  acknowledgeOperation,
  beginOperation,
  bindOperationToSession,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"
import {
  reconcilePendingPromptSubmissions,
  reconcileQueuedPromptActions,
  removePendingPromptSubmission,
  updatePendingPromptSubmission,
} from "./pending-prompt-state"
import { clearPersistedActiveSessionId, writePersistedActiveSessionId } from "./persistence"
import { acceptActiveSessionView, reconcileRuntimeWithView } from "./session-view-state"
import type {
  DesktopSessionRuntime,
  DesktopStoreContext,
  PendingPromptSubmission,
  SessionActions,
} from "./types"

interface SessionActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createSessionActions(context: SessionActionsContext): SessionActions {
  const { get, set } = context

  return {
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
      const operationId = globalThis.crypto.randomUUID()
      set((state) => {
        const switchingSessions = state.activeSessionId !== sessionId
        const runtime = state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
        return {
          activeSessionId: sessionId,
          sessionView: null,
          openingSession: true,
          sending: switchingSessions ? false : state.sending,
          sendingOperationId: switchingSessions ? null : state.sendingOperationId,
          error: null,
          sessionRuntimes: {
            ...state.sessionRuntimes,
            [sessionId]: beginOperation(runtime, {
              id: operationId,
              kind: "open-session",
              sessionId,
              startedAt: Date.now(),
            }),
          },
        }
      })
      try {
        const view = await window.desktop.sessions.open(sessionId)
        let snapshotApplied = false
        set((state) => {
          const runtime = state.sessionRuntimes[sessionId]
          const operation = runtime?.operations[operationId]
          if (state.activeSessionId !== sessionId || !operation || operation.phase !== "pending") {
            return state
          }

          const acceptedView = acceptActiveSessionView(
            state.activeSessionId,
            state.sessionView,
            view
          )
          const settledRuntime = reconcileRuntimeWithView(
            removeOperation(runtime, operationId),
            view
          )
          if (acceptedView !== view) {
            return {
              openingSession: false,
              sessionRuntimes: {
                ...state.sessionRuntimes,
                [sessionId]: settledRuntime,
              },
            }
          }

          snapshotApplied = true
          const workspace = resolveSessionWorkspace(state.projects, view.session)
          return {
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
            selectedPermissionMode: sessionPermissionMode(
              view.session,
              state.defaultPermissionMode
            ),
            sessions:
              view.session.status === "archived"
                ? state.sessions.filter((session) => session.id !== view.session.id)
                : upsertSession(state.sessions, view.session),
            archivedSessions:
              view.session.status === "archived"
                ? upsertSession(state.archivedSessions, view.session)
                : state.archivedSessions,
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: settledRuntime,
            },
          }
        })
        if (!snapshotApplied) return

        writePersistedActiveSessionId(sessionId)
        const workspace = resolveSessionWorkspace(get().projects, view.session)
        if (workspace.selectedProject) {
          try {
            const details = await window.desktop.sessions.inspectProject(
              workspace.selectedProject.path
            )
            if (get().activeSessionId !== sessionId) return
            set((state) => ({
              projects: upsertProject(state.projects, details.project),
              selectedProject: details.project,
              selectedProjectGit:
                details.git ?? Boolean(details.branch || details.branches?.length),
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
        set((state) => {
          const runtime = state.sessionRuntimes[sessionId]
          const operation = runtime?.operations[operationId]
          if (state.activeSessionId !== sessionId || !operation || operation.phase !== "pending") {
            return state
          }
          clearPersistedActiveSessionId()
          return {
            openingSession: false,
            error: errorMessage(error),
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: failOperation(runtime, operationId, errorMessage(error), Date.now()),
            },
          }
        })
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
          sessionRuntimes: removeSessionRuntimes(state.sessionRuntimes, new Set([sessionId])),
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
            state.sessionView && deleted.has(state.sessionView.session.id)
              ? null
              : state.sessionView,
          pendingPromptSubmissions: filterPendingPromptSubmissions(
            state.pendingPromptSubmissions,
            (submission) => !deleted.has(submission.sessionId)
          ),
          queuedPromptActions: filterQueuedPromptActions(
            state.queuedPromptActions,
            (action) => !deleted.has(action.sessionId)
          ),
          sessionRuntimes: removeSessionRuntimes(state.sessionRuntimes, deleted),
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

    async startSession(content, options) {
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
      set((state) => ({
        sending: true,
        sendingOperationId: promptSubmissionId,
        error: null,
        newConversationRuntime: beginOperation(state.newConversationRuntime, {
          id: promptSubmissionId,
          kind: "create-session",
          sessionId: null,
          startedAt: Date.now(),
        }),
      }))
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
        const firstSubmission: PendingPromptSubmission | null = options?.commandLine
          ? null
          : {
              id: promptSubmissionId,
              sessionId: session.id,
              content: prompt,
              createdAt: Date.now(),
              phase: "submitting",
              placement: "transcript",
            }
        let ownsCurrentPage = false
        set((state) => {
          ownsCurrentPage =
            state.sendingOperationId === promptSubmissionId &&
            state.newConversationRuntime.operations[promptSubmissionId]?.phase === "pending"
          const bound = bindOperationToSession(
            state.newConversationRuntime,
            state.sessionRuntimes[session.id] ?? createEmptySessionRuntime(),
            promptSubmissionId,
            session.id
          )
          const runtime = firstSubmission
            ? {
                ...bound.target,
                pendingPromptSubmissions: {
                  ...bound.target.pendingPromptSubmissions,
                  [promptSubmissionId]: firstSubmission,
                },
              }
            : bound.target
          return {
            sessions: upsertSession(state.sessions, session),
            newConversationRuntime: bound.source,
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [session.id]: acknowledgeOperation(runtime, promptSubmissionId, Date.now()),
            },
            ...(ownsCurrentPage
              ? {
                  activeSessionId: session.id,
                  openingSession: true,
                }
              : {}),
            ...(firstSubmission
              ? {
                  pendingPromptSubmissions: {
                    ...state.pendingPromptSubmissions,
                    [promptSubmissionId]: firstSubmission,
                  },
                }
              : {}),
          }
        })
        if (ownsCurrentPage) await get().openSession(session.id)
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
            sessionRuntimes: updateSessionRuntime(state.sessionRuntimes, session.id, (runtime) => ({
              ...runtime,
              pendingPromptSubmissions: updatePendingPromptSubmission(
                runtime.pendingPromptSubmissions,
                promptSubmissionId,
                (submission) => ({ ...submission, phase: "accepted", error: undefined })
              ),
            })),
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
          newConversationRuntime: startedSessionId
            ? state.newConversationRuntime
            : failOperation(state.newConversationRuntime, promptSubmissionId, message, Date.now()),
          sessionRuntimes: startedSessionId
            ? updateSessionRuntime(state.sessionRuntimes, startedSessionId, (runtime) =>
                failOperation(runtime, promptSubmissionId, message, Date.now())
              )
            : state.sessionRuntimes,
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
        context.scheduleSelectedProjectGitRefresh(true)
      }
      return startedSessionId
    },
  }
}

function filterPendingPromptSubmissions(
  submissions: Record<string, PendingPromptSubmission>,
  keep: (submission: PendingPromptSubmission) => boolean
): Record<string, PendingPromptSubmission> {
  return Object.fromEntries(
    Object.entries(submissions).filter(([, submission]) => keep(submission))
  )
}

function filterQueuedPromptActions(
  actions: DesktopSessionRuntime["queuedPromptActions"],
  keep: (action: DesktopSessionRuntime["queuedPromptActions"][string]) => boolean
): DesktopSessionRuntime["queuedPromptActions"] {
  return Object.fromEntries(Object.entries(actions).filter(([, action]) => keep(action)))
}

function removeSessionRuntimes(
  runtimes: Record<string, DesktopSessionRuntime>,
  sessionIds: Set<string>
): Record<string, DesktopSessionRuntime> {
  return Object.fromEntries(
    Object.entries(runtimes).filter(([sessionId]) => !sessionIds.has(sessionId))
  )
}

function updateSessionRuntime(
  runtimes: Record<string, DesktopSessionRuntime>,
  sessionId: string,
  update: (runtime: DesktopSessionRuntime) => DesktopSessionRuntime
): Record<string, DesktopSessionRuntime> {
  const runtime = runtimes[sessionId]
  if (!runtime) return runtimes
  return { ...runtimes, [sessionId]: update(runtime) }
}

function sessionViewContainsInput(view: DesktopSessionView | null, inputId: string): boolean {
  return Boolean(view?.inputs.some((input) => input.id === inputId))
}
