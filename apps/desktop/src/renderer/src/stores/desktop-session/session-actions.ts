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
  removePendingPromptSubmission,
  updatePendingPromptSubmission,
} from "./pending-prompt-state"
import { clearPersistedActiveSessionId, writePersistedActiveSessionId } from "./persistence"
import {
  acceptActiveSessionView,
  reconcileRuntimeWithView,
  releaseAcknowledgedRuntime,
} from "./session-view-state"
import type {
  DesktopSessionRuntime,
  DesktopSessionState,
  DesktopStoreContext,
  PendingPromptSubmission,
  SessionActions,
} from "./types"

interface SessionActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

type OpenSessionResult = "applied" | "cancelled" | "failed"

export function createSessionActions(context: SessionActionsContext): SessionActions {
  const { get, set, projectDetailsCoordinator } = context
  let primaryNavigationGeneration = 0
  let defaultSettingsGeneration = 0
  let defaultSettingsWrite: Promise<void> = Promise.resolve()
  const advancePrimaryNavigation = (): number => {
    primaryNavigationGeneration += 1
    return primaryNavigationGeneration
  }
  const openPrimarySession = async (sessionId: string): Promise<OpenSessionResult> => {
    const projectSelectionGeneration = projectDetailsCoordinator.beginSelection()
    const operationId = globalThis.crypto.randomUUID()
    set((state) => {
      const previousActiveSessionId = state.activeSessionId
      const runtime = state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
      const openingRuntime = beginOperation(abandonOpenSessionOperations(runtime), {
        id: operationId,
        kind: "open-session",
        sessionId,
        startedAt: Date.now(),
      })
      return {
        activeSessionId: sessionId,
        sessionView: null,
        sessionRuntimes: {
          ...state.sessionRuntimes,
          ...(previousActiveSessionId && previousActiveSessionId !== sessionId
            ? {
                [previousActiveSessionId]: releaseAcknowledgedRuntime(
                  state.sessionRuntimes[previousActiveSessionId] ?? createEmptySessionRuntime()
                ),
              }
            : {}),
          [sessionId]: openingRuntime,
        },
      }
    })
    try {
      const view = await window.desktop.sessions.open(sessionId)
      let snapshotApplied = false
      set((state) => {
        const runtime = state.sessionRuntimes[sessionId]
        const operation = runtime?.operations[operationId]
        if (!operation || operation.phase !== "pending") {
          return state
        }
        if (state.activeSessionId !== sessionId) {
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: removeOperation(runtime, operationId),
            },
          }
        }

        const acceptedView = acceptActiveSessionView(state.activeSessionId, state.sessionView, view)
        const settledRuntime = reconcileRuntimeWithView(removeOperation(runtime, operationId), view)
        if (acceptedView !== view) {
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: settledRuntime,
            },
          }
        }

        snapshotApplied = true
        const workspace = resolveSessionWorkspace(state.projects, view.session)
        const ownsProjectSelection = projectDetailsCoordinator.ownsSelection(
          projectSelectionGeneration
        )
        return {
          ...(ownsProjectSelection ? workspace : {}),
          sessionView: view,
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
          sessionRuntimes: {
            ...state.sessionRuntimes,
            [sessionId]: settledRuntime,
          },
        }
      })
      if (!snapshotApplied) return "cancelled"

      writePersistedActiveSessionId(sessionId)
      const workspace = resolveSessionWorkspace(get().projects, view.session)
      if (
        workspace.selectedProject &&
        projectDetailsCoordinator.ownsSelection(projectSelectionGeneration)
      ) {
        const projectId = workspace.selectedProject.id
        const projectDetailsGeneration = projectDetailsCoordinator.beginDetails(projectId)
        try {
          const details = await window.desktop.sessions.inspectProject(
            workspace.selectedProject.path
          )
          if (
            get().activeSessionId !== sessionId ||
            get().selectedProject?.id !== projectId ||
            !projectDetailsCoordinator.ownsDetails(projectId, projectDetailsGeneration)
          )
            return "cancelled"
          set((state) => ({
            projects: upsertProject(state.projects, details.project),
            selectedProject: details.project,
            selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
            selectedProjectGitCheckedAt: Date.now(),
            branch: details.branch,
            branches: details.branches ?? [],
          }))
        } catch {
          if (
            get().activeSessionId === sessionId &&
            get().selectedProject?.id === projectId &&
            projectDetailsCoordinator.ownsDetails(projectId, projectDetailsGeneration)
          ) {
            set({
              selectedProjectGit: false,
              selectedProjectGitCheckedAt: Date.now(),
              branch: null,
              branches: [],
            })
          }
        }
      }
      return "applied"
    } catch (error) {
      let failed = false
      set((state) => {
        const runtime = state.sessionRuntimes[sessionId]
        const operation = runtime?.operations[operationId]
        if (!operation || operation.phase !== "pending") {
          return state
        }
        if (state.activeSessionId !== sessionId) {
          return {
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [sessionId]: removeOperation(runtime, operationId),
            },
          }
        }
        failed = true
        clearPersistedActiveSessionId()
        const failedRuntime = failOperation(runtime, operationId, errorMessage(error), Date.now())
        return {
          sessionRuntimes: {
            ...state.sessionRuntimes,
            [sessionId]: failedRuntime,
          },
        }
      })
      return failed ? "failed" : "cancelled"
    }
  }

  return {
    async startNewConversation() {
      advancePrimaryNavigation()
      await window.desktop.sessions.close()
      clearPersistedActiveSessionId()
      const newConversationRuntime = createEmptySessionRuntime()
      set((state) => ({
        activeSessionId: null,
        sessionView: null,
        selectedModel: state.defaultModel,
        selectedProvider: state.defaultProvider,
        selectedPermissionMode: state.defaultPermissionMode,
        newConversationRuntime,
        sessionRuntimes: releaseActiveSessionAcknowledgements(state),
      }))
    },

    async selectModel(model) {
      const generation = ++defaultSettingsGeneration
      set({
        selectedModel: model.id,
        selectedProvider: model.providerName,
        defaultModel: model.id,
        defaultProvider: model.providerName,
      })
      try {
        const request = defaultSettingsWrite.then(() =>
          window.desktop.sessions.setDefaultModel({
            model: model.id,
            provider: model.providerName,
          })
        )
        defaultSettingsWrite = request.then(
          () => undefined,
          () => undefined
        )
        const data = await request
        if (generation !== defaultSettingsGeneration) return
        set((state) =>
          applyBootstrapData(
            data,
            state.selectedProject,
            state.workspaceMode,
            model.id,
            model.providerName
          )
        )
      } catch {
        if (generation !== defaultSettingsGeneration) return
      }
    },

    async selectPermissionMode(permissionMode) {
      const generation = ++defaultSettingsGeneration
      set({
        selectedPermissionMode: permissionMode,
        defaultPermissionMode: permissionMode,
      })
      try {
        const request = defaultSettingsWrite.then(() =>
          window.desktop.sessions.setDefaultPermissionMode({ permissionMode })
        )
        defaultSettingsWrite = request.then(
          () => undefined,
          () => undefined
        )
        const data = await request
        if (generation !== defaultSettingsGeneration) return
        set((state) => ({
          ...applyBootstrapData(
            data,
            state.selectedProject,
            state.workspaceMode,
            state.selectedModel,
            state.selectedProvider
          ),
          selectedPermissionMode: permissionMode,
          defaultPermissionMode: permissionMode,
        }))
      } catch {
        if (generation !== defaultSettingsGeneration) return
      }
    },

    async updateSessionModel(sessionId, model) {
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
      }))
    },

    async updateSessionPermissionMode(sessionId, permissionMode) {
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
      }))
    },

    async openSession(sessionId) {
      if (!sessionId) return
      advancePrimaryNavigation()
      await openPrimarySession(sessionId)
    },

    async resyncActiveSessionSnapshot() {
      const sessionId = get().activeSessionId
      if (!sessionId) return
      const runtime = get().sessionRuntimes[sessionId]
      if (
        Object.values(runtime?.operations ?? {}).some(
          (operation) => operation.kind === "open-session" && operation.phase === "pending"
        )
      )
        return
      try {
        const view = await window.desktop.sessions.open(sessionId)
        if (get().activeSessionId === sessionId) get().applySessionUpdate(view)
      } catch {
        // A resync is only a recovery read. It must not replace a user-owned open error.
      }
    },

    async startConversationFrom(session) {
      advancePrimaryNavigation()
      await window.desktop.sessions.close()
      clearPersistedActiveSessionId()
      const workspace = resolveSessionWorkspace(get().projects, session)
      const newConversationRuntime = createEmptySessionRuntime()
      set((state) => ({
        activeSessionId: null,
        sessionView: null,
        ...workspace,
        selectedModel: session.model,
        selectedProvider: sessionProvider(session, get().defaultProvider),
        selectedPermissionMode: sessionPermissionMode(session, get().defaultPermissionMode),
        selectedProjectGit: false,
        selectedProjectGitCheckedAt: null,
        branch: null,
        branches: [],
        newConversationRuntime,
        sessionRuntimes: releaseActiveSessionAcknowledgements(state),
      }))
      if (workspace.selectedProject) await get().selectProject(workspace.selectedProject)
    },

    async forkSession(sessionId, options) {
      if (!sessionId) throw new Error("会话 ID 不能为空")
      const navigationOwnerSessionId = get().activeSessionId
      const navigationOwnerGeneration = primaryNavigationGeneration
      const session = await window.desktop.sessions.fork({
        sessionId,
        ...(options?.beforeMessageId ? { beforeMessageId: options.beforeMessageId } : {}),
        ...(options?.afterMessageId ? { afterMessageId: options.afterMessageId } : {}),
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        archivedSessions: state.archivedSessions.filter((item) => item.id !== session.id),
      }))
      if (
        primaryNavigationGeneration === navigationOwnerGeneration &&
        get().activeSessionId === navigationOwnerSessionId
      ) {
        await get().openSession(session.id)
      }
      return session
    },

    async renameSession(sessionId, title) {
      const normalizedTitle = title.replace(/\s+/g, " ").trim()
      if (!normalizedTitle) return
      const session = await window.desktop.sessions.rename({ sessionId, title: normalizedTitle })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
      }))
    },

    async togglePinSession(sessionId) {
      const existing = get().sessions.find((session) => session.id === sessionId)
      if (!existing) return
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
      }))
    },

    async archiveSession(sessionId) {
      const existing = get().sessions.find((session) => session.id === sessionId)
      if (!existing) return
      const invalidatesPrimaryNavigation = get().activeSessionId === sessionId
      if (invalidatesPrimaryNavigation) advancePrimaryNavigation()
      const archived = await window.desktop.sessions.archive(sessionId)
      const isActive = get().activeSessionId === sessionId
      set((state) => ({
        ...(isActive ? resolveSessionWorkspace(state.projects, existing) : {}),
        sessions: state.sessions.filter((session) => session.id !== sessionId),
        archivedSessions: upsertSession(state.archivedSessions, archived),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView: isActive ? null : state.sessionView,
        sessionRuntimes: removeSessionRuntimes(state.sessionRuntimes, new Set([sessionId])),
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
      }))
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
      }
    },

    async deleteSession(sessionId) {
      const existing =
        get().sessions.find((session) => session.id === sessionId) ??
        get().archivedSessions.find((session) => session.id === sessionId)
      if (!existing) return
      const invalidatesPrimaryNavigation = get().activeSessionId === sessionId
      if (invalidatesPrimaryNavigation) advancePrimaryNavigation()
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
        sessionRuntimes: removeSessionRuntimes(state.sessionRuntimes, deleted),
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
      }))
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
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
      if (
        !prompt ||
        Object.values(get().newConversationRuntime.operations).some(
          (operation) => operation.kind === "create-session" && operation.phase === "pending"
        )
      )
        return null
      if (workspaceMode === "project" && !selectedProject) {
        return null
      }
      if (!model) {
        return null
      }

      const promptSubmissionId = globalThis.crypto.randomUUID()
      const navigationOwnerGeneration = primaryNavigationGeneration
      const createOperation = {
        id: promptSubmissionId,
        kind: "create-session" as const,
        sessionId: null,
        startedAt: Date.now(),
      }
      let commandOperationId: string | null = null
      let startedSessionId: string | null = null
      set((state) => {
        const newConversationRuntime = beginOperation(state.newConversationRuntime, createOperation)
        return {
          newConversationRuntime,
        }
      })
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
          const ownsNewConversationRuntime =
            state.newConversationRuntime.operations[promptSubmissionId]?.phase === "pending"
          ownsCurrentPage =
            navigationOwnerGeneration === primaryNavigationGeneration && ownsNewConversationRuntime
          if (ownsCurrentPage) advancePrimaryNavigation()
          const bound = ownsNewConversationRuntime
            ? bindOperationToSession(
                state.newConversationRuntime,
                state.sessionRuntimes[session.id] ?? createEmptySessionRuntime(),
                promptSubmissionId,
                session.id
              )
            : {
                source: state.newConversationRuntime,
                target: bindOperationToSession(
                  beginOperation(createEmptySessionRuntime(), createOperation),
                  state.sessionRuntimes[session.id] ?? createEmptySessionRuntime(),
                  promptSubmissionId,
                  session.id
                ).target,
              }
          const runtime = firstSubmission
            ? {
                ...bound.target,
                pendingPromptSubmissions: {
                  ...bound.target.pendingPromptSubmissions,
                  [promptSubmissionId]: firstSubmission,
                },
              }
            : bound.target
          const acknowledgedRuntime = acknowledgeOperation(runtime, promptSubmissionId, Date.now())
          return {
            sessions: upsertSession(state.sessions, session),
            newConversationRuntime: bound.source,
            sessionRuntimes: {
              ...state.sessionRuntimes,
              [session.id]: acknowledgedRuntime,
            },
            ...(ownsCurrentPage
              ? {
                  activeSessionId: session.id,
                }
              : {}),
          }
        })
        const openResult = ownsCurrentPage ? await openPrimarySession(session.id) : "cancelled"
        if (options?.commandLine) {
          if (openResult === "failed") {
            const openError = Object.values(
              get().sessionRuntimes[session.id]?.operations ?? {}
            ).find((operation) => operation.kind === "open-session" && operation.phase === "failed")
            throw new Error(openError?.error ?? "无法打开新会话")
          }
          const invokeCommandOperationId = globalThis.crypto.randomUUID()
          commandOperationId = invokeCommandOperationId
          set((state) => {
            const sessionRuntimes = updateSessionRuntime(
              state.sessionRuntimes,
              session.id,
              (runtime) =>
                beginOperation(runtime, {
                  id: invokeCommandOperationId,
                  kind: "invoke-command",
                  sessionId: session.id,
                  target: options.commandLine,
                  startedAt: Date.now(),
                })
            )
            return { sessionRuntimes }
          })
          await window.desktop.sessions.invokeCommand({
            sessionId: session.id,
            line: options.commandLine,
          })
          if (commandOperationId) {
            set((state) => {
              const backgroundCommand = get().activeSessionId !== session.id
              const sessionRuntimes = updateSessionRuntime(
                state.sessionRuntimes,
                session.id,
                (runtime) => {
                  const afterCommand = removeOperation(runtime, invokeCommandOperationId)
                  return backgroundCommand
                    ? removeOperation(afterCommand, promptSubmissionId)
                    : afterCommand
                }
              )
              return { sessionRuntimes }
            })
          }
        } else {
          await window.desktop.sessions.sendPrompt({
            id: promptSubmissionId,
            sessionId: session.id,
            content: prompt,
          })
          const keepLocalAcknowledgement = get().activeSessionId === session.id
          set((state) => {
            const sessionRuntimes = updateSessionRuntime(
              state.sessionRuntimes,
              session.id,
              (runtime) => {
                const acceptedRuntime = {
                  ...runtime,
                  pendingPromptSubmissions: updatePendingPromptSubmission(
                    runtime.pendingPromptSubmissions,
                    promptSubmissionId,
                    (submission) => ({ ...submission, phase: "accepted", error: undefined })
                  ),
                }
                return keepLocalAcknowledgement
                  ? acceptedRuntime
                  : removeOperation(
                      {
                        ...acceptedRuntime,
                        pendingPromptSubmissions: removePendingPromptSubmission(
                          acceptedRuntime.pendingPromptSubmissions,
                          promptSubmissionId
                        ),
                      },
                      promptSubmissionId
                    )
              }
            )
            return { sessionRuntimes }
          })
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
        const currentSessionRuntime = startedSessionId
          ? currentState.sessionRuntimes[startedSessionId]
          : null
        const confirmed =
          !options?.commandLine &&
          Boolean(
            !currentSessionRuntime?.pendingPromptSubmissions[promptSubmissionId] ||
            (currentState.activeSessionId === startedSessionId &&
              sessionViewContainsInput(currentState.sessionView, promptSubmissionId))
          )
        set((state) => {
          const ownsNewConversation =
            navigationOwnerGeneration === primaryNavigationGeneration &&
            state.newConversationRuntime.operations[promptSubmissionId]?.phase === "pending"
          const sessionRuntimes = startedSessionId
            ? updateSessionRuntime(state.sessionRuntimes, startedSessionId, (runtime) => {
                if (commandOperationId) {
                  return failOperation(runtime, commandOperationId, message, Date.now())
                }
                return {
                  ...runtime,
                  pendingPromptSubmissions: confirmed
                    ? removePendingPromptSubmission(
                        runtime.pendingPromptSubmissions,
                        promptSubmissionId
                      )
                    : updatePendingPromptSubmission(
                        runtime.pendingPromptSubmissions,
                        promptSubmissionId,
                        (submission) => ({ ...submission, phase: "failed", error: message })
                      ),
                }
              })
            : state.sessionRuntimes
          const newConversationRuntime = ownsNewConversation
            ? failOperation(state.newConversationRuntime, promptSubmissionId, message, Date.now())
            : state.newConversationRuntime
          return {
            newConversationRuntime,
            sessionRuntimes,
          }
        })
        if (confirmed) return startedSessionId
        throw error
      } finally {
        context.scheduleSelectedProjectGitRefresh(true)
      }
      return startedSessionId
    },
  }
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

function abandonOpenSessionOperations(runtime: DesktopSessionRuntime): DesktopSessionRuntime {
  const operations = Object.fromEntries(
    Object.entries(runtime.operations).filter(([, operation]) => operation.kind !== "open-session")
  )
  return Object.keys(operations).length === Object.keys(runtime.operations).length
    ? runtime
    : { ...runtime, operations }
}

function sessionViewContainsInput(view: DesktopSessionView | null, inputId: string): boolean {
  return Boolean(view?.inputs.some((input) => input.id === inputId))
}

function releaseActiveSessionAcknowledgements(
  state: Pick<DesktopSessionState, "activeSessionId" | "sessionRuntimes">
): DesktopSessionState["sessionRuntimes"] {
  const sessionId = state.activeSessionId
  if (!sessionId) return state.sessionRuntimes
  return {
    ...state.sessionRuntimes,
    [sessionId]: releaseAcknowledgedRuntime(
      state.sessionRuntimes[sessionId] ?? createEmptySessionRuntime()
    ),
  }
}
