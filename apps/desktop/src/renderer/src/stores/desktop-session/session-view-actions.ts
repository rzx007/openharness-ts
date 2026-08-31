import {
  isPlaceholderTitle,
  sessionPermissionMode,
  sessionProvider,
  upsertSession,
} from "./helpers"
import { createEmptySessionRuntime } from "./operation-state"
import { clearPersistedActiveSessionId, writePersistedActiveSessionId } from "./persistence"
import { acceptActiveSessionView, reconcileRuntimeWithView } from "./session-view-state"
import { notifyForSessionViewChange } from "./notification-observer"
import type { DesktopSessionState, DesktopStoreContext } from "./types"

interface SessionViewActionsContext extends DesktopStoreContext {
  scheduleSelectedProjectGitRefresh: (force: boolean) => void
}

export function createApplySessionUpdate(
  context: SessionViewActionsContext
): DesktopSessionState["applySessionUpdate"] {
  const { get, set } = context

  return (view) => {
    const current = get().sessionView
    if (acceptActiveSessionView(get().activeSessionId, current, view) !== view) return
    void notifyForSessionViewChange({ previous: current, next: view })
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
        sessionRuntimes: { ...state.sessionRuntimes, [view.session.id]: runtime },
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
    context.scheduleSelectedProjectGitRefresh(true)
  }
}
