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
import { createEmptySessionRuntime } from "./desktop-session/operation-state"
import {
  acceptActiveSessionView,
  reconcileRuntimeWithView,
} from "./desktop-session/session-view-state"
import { createProjectActions } from "./desktop-session/project-actions"
import { createSessionActions } from "./desktop-session/session-actions"
import { createPromptActions } from "./desktop-session/prompt-actions"
import { createQueuedPromptActions } from "./desktop-session/queued-prompt-actions"
import {
  clearPersistedActiveSessionId,
  writePersistedActiveSessionId,
} from "./desktop-session/persistence"
import type { DesktopSessionState } from "./desktop-session/types"

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
  ...createPromptActions({ set, get, scheduleSelectedProjectGitRefresh }),
  ...createQueuedPromptActions({ set, get, scheduleSelectedProjectGitRefresh }),

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

      const runtime = reconcileRuntimeWithView(
        state.sessionRuntimes[view.session.id] ?? createEmptySessionRuntime(),
        view
      )

      return {
        sessionView: { ...view, session },
        // These top-level fields remain a temporary compatibility mirror until task 6
        // migrates the conversation components to session runtime selectors.
        pendingPromptSubmissions: runtime.pendingPromptSubmissions,
        pendingPromptEdit: runtime.pendingPromptEdit,
        queuedPromptActions: runtime.queuedPromptActions,
        sending: false,
        sendingOperationId: null,
        sessionRuntimes: { ...state.sessionRuntimes, [view.session.id]: runtime },
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

function scheduleSelectedProjectGitRefresh(force: boolean): void {
  if (selectedProjectGitRefreshTimer) clearTimeout(selectedProjectGitRefreshTimer)
  selectedProjectGitRefreshTimer = setTimeout(() => {
    selectedProjectGitRefreshTimer = null
    void useDesktopSessionStore.getState().refreshSelectedProjectGit({ force })
  }, selectedProjectGitRefreshDelayMs)
}
