import type {
  DesktopBootstrapData,
  DesktopProject,
  DesktopWorkspaceMode,
} from "@shared/session-types"
import { normalizeDesktopAttachmentSupport } from "@shared/attachment-types"

import {
  beginScopedOperation,
  errorMessage,
  failScopedOperation,
  removeScopedOperation,
} from "./error-state"
import { resolveInitialProject, sortSessions } from "./helpers"
import { clearPersistedActiveSessionId, readPersistedActiveSessionId } from "./persistence"
import type { BootstrapActions, DesktopSessionState, DesktopStoreContext } from "./types"

export function createBootstrapActions(context: DesktopStoreContext): BootstrapActions {
  const { get, set } = context

  return {
    async initialize() {
      if (get().loadStatus === "loading" || get().loadStatus === "ready") return
      const operationId = globalThis.crypto.randomUUID()
      set((state) => ({
        loadStatus: "loading",
        daemonStatus: {
          phase: "discovering",
          message: "正在观察 daemon 状态",
          updatedAt: Date.now(),
        },
        appOperations: beginScopedOperation(state.appOperations, {
          id: operationId,
          kind: "project-action",
          sessionId: null,
          target: "initialize",
          startedAt: Date.now(),
        }),
      }))
      try {
        const daemonStatus = await window.desktop.sessions.daemonStatus()
        set({ daemonStatus })
        const data = await window.desktop.sessions.bootstrap()
        const latestDaemonStatus = await window.desktop.sessions
          .daemonStatus()
          .catch(() => get().daemonStatus)
        const workspaceMode =
          get().workspaceMode === "outside_project" || data.projects.length === 0
            ? "outside_project"
            : "project"
        const selectedProject = resolveInitialProject(data, get().selectedProject, workspaceMode)
        const sessions = sortSessions(data.sessions)
        const archivedSessions = sortSessions(data.archivedSessions)
        const persistedSessionId = readPersistedActiveSessionId()
        set({
          loadStatus: "ready",
          daemonStatus: latestDaemonStatus,
          projects: data.projects,
          sessions,
          archivedSessions,
          models: data.models,
          attachmentSupport: normalizeDesktopAttachmentSupport(data.attachments),
          defaultModel: data.defaultModel,
          defaultProvider: data.defaultProvider ?? null,
          defaultPermissionMode: data.defaultPermissionMode,
          selectedModel: data.defaultModel,
          selectedProvider: data.defaultProvider ?? null,
          selectedPermissionMode: data.defaultPermissionMode,
          workspaceMode,
          selectedProject,
          selectedProjectGit: false,
          selectedProjectGitCheckedAt: null,
          branches: [],
        })
        if (selectedProject)
          await get()
            .selectProject(selectedProject)
            .catch(() => undefined)
        if (persistedSessionId && sessions.some((session) => session.id === persistedSessionId)) {
          await get().openSession(persistedSessionId)
        } else if (persistedSessionId) {
          clearPersistedActiveSessionId()
        }
        set((state) => ({
          appOperations: removeScopedOperation(state.appOperations, operationId),
        }))
      } catch (error) {
        const daemonStatus = await window.desktop.sessions
          .daemonStatus()
          .catch(() => get().daemonStatus)
        const message = errorMessage(error)
        set((state) => ({
          loadStatus: "error",
          daemonStatus,
          appOperations: failScopedOperation(state.appOperations, operationId, message, Date.now()),
        }))
      }
    },

    async refreshBootstrap() {
      const operationId = globalThis.crypto.randomUUID()
      set((state) => ({
        appOperations: beginScopedOperation(state.appOperations, {
          id: operationId,
          kind: "project-action",
          sessionId: null,
          target: "refresh-bootstrap",
          startedAt: Date.now(),
        }),
      }))
      try {
        const data = await window.desktop.sessions.bootstrap()
        set((state) => ({
          ...applyBootstrapData(data, state.selectedProject, state.workspaceMode, null, null),
          ...(state.activeSessionId
            ? {
                selectedModel: state.selectedModel,
                selectedProvider: state.selectedProvider,
                selectedPermissionMode: state.selectedPermissionMode,
              }
            : {}),
          appOperations: removeScopedOperation(state.appOperations, operationId),
        }))
      } catch (error) {
        set((state) => ({
          appOperations: failScopedOperation(
            state.appOperations,
            operationId,
            errorMessage(error),
            Date.now()
          ),
        }))
        throw error
      }
    },
  }
}

export function attachDesktopDaemonStatusEvents(context: DesktopStoreContext): () => void {
  return window.desktop.sessions.onDaemonStatusChanged((daemonStatus) => {
    context.set({ daemonStatus })
  })
}

export function applyBootstrapData(
  data: DesktopBootstrapData,
  currentProject: DesktopProject | null,
  workspaceMode: DesktopWorkspaceMode,
  preferredModel: string | null,
  preferredProvider: string | null
): Partial<DesktopSessionState> {
  const resolvedWorkspaceMode =
    workspaceMode === "project" && data.projects.length === 0 ? "outside_project" : workspaceMode
  const selectedProject = resolveInitialProject(data, currentProject, resolvedWorkspaceMode)
  const preferredExists =
    preferredModel &&
    data.models.some(
      (item) => item.id === preferredModel && item.providerName === preferredProvider
    )
  const model = preferredExists ? preferredModel : data.defaultModel
  const provider = preferredExists ? preferredProvider : (data.defaultProvider ?? null)
  return {
    loadStatus: "ready",
    projects: data.projects,
    sessions: sortSessions(data.sessions),
    archivedSessions: sortSessions(data.archivedSessions),
    models: data.models,
    attachmentSupport: normalizeDesktopAttachmentSupport(data.attachments),
    defaultModel: data.defaultModel,
    defaultProvider: data.defaultProvider ?? null,
    defaultPermissionMode: data.defaultPermissionMode,
    selectedModel: model,
    selectedProvider: provider,
    selectedPermissionMode: data.defaultPermissionMode,
    workspaceMode: resolvedWorkspaceMode,
    selectedProject,
  }
}
