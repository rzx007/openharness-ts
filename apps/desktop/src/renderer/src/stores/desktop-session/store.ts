import { create } from "zustand"

import { attachDesktopDaemonStatusEvents, createBootstrapActions } from "./bootstrap-actions"
import { createInitialState } from "./initial-state"
import { createProjectActions } from "./project-actions"
import { createSelectedProjectGitRefreshScheduler } from "./project-git-scheduler"
import { createPromptActions } from "./prompt-actions"
import { createQueuedPromptActions } from "./queued-prompt-actions"
import { createSessionActions } from "./session-actions"
import { createApplySessionUpdate } from "./session-view-actions"
import type { DesktopSessionState } from "./types"

const selectedProjectGitRefreshScheduler = createSelectedProjectGitRefreshScheduler(
  (options) => useDesktopSessionStore.getState().refreshSelectedProjectGit(options),
  750
)
let desktopSessionEventSubscriptionCount = 0
let detachDesktopSessionUpdates: (() => void) | null = null
let detachDesktopDaemonStatus: (() => void) | null = null

export const useDesktopSessionStore = create<DesktopSessionState>((set, get) => {
  const context = {
    set,
    get,
    scheduleSelectedProjectGitRefresh: selectedProjectGitRefreshScheduler.schedule,
  }

  return {
    ...createInitialState(),
    ...createBootstrapActions(context),
    ...createProjectActions(context),
    ...createSessionActions(context),
    ...createPromptActions(context),
    ...createQueuedPromptActions(context),
    applySessionUpdate: createApplySessionUpdate(context),
  }
})

export function attachDesktopSessionEvents(): () => void {
  if (desktopSessionEventSubscriptionCount === 0) {
    detachDesktopDaemonStatus = attachDesktopDaemonStatusEvents({
      set: useDesktopSessionStore.setState,
      get: useDesktopSessionStore.getState,
    })
    detachDesktopSessionUpdates = window.desktop.sessions.onUpdated((view) => {
      useDesktopSessionStore.getState().applySessionUpdate(view)
    })
    const activeSessionId = useDesktopSessionStore.getState().activeSessionId
    if (activeSessionId && typeof window.desktop.sessions.open === "function") {
      void useDesktopSessionStore.getState().openSession(activeSessionId)
    }
  }
  desktopSessionEventSubscriptionCount += 1

  let cleanedUp = false
  return () => {
    if (cleanedUp) return
    cleanedUp = true
    desktopSessionEventSubscriptionCount -= 1
    if (desktopSessionEventSubscriptionCount > 0) return

    detachDesktopSessionUpdates?.()
    detachDesktopDaemonStatus?.()
    detachDesktopSessionUpdates = null
    detachDesktopDaemonStatus = null
    selectedProjectGitRefreshScheduler.reset()
  }
}
