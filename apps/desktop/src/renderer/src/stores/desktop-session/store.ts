import { create } from "zustand"

import { attachDesktopDaemonStatusEvents, createBootstrapActions } from "./bootstrap-actions"
import { createInitialState } from "./initial-state"
import { createProjectActions } from "./project-actions"
import { createPromptActions } from "./prompt-actions"
import { createQueuedPromptActions } from "./queued-prompt-actions"
import { createSessionActions } from "./session-actions"
import { createApplySessionUpdate } from "./session-view-actions"
import type { DesktopSessionState } from "./types"

const selectedProjectGitRefreshDelayMs = 750

export const useDesktopSessionStore = create<DesktopSessionState>((set, get) => {
  let selectedProjectGitRefreshTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSelectedProjectGitRefresh = (force: boolean): void => {
    if (selectedProjectGitRefreshTimer) clearTimeout(selectedProjectGitRefreshTimer)
    selectedProjectGitRefreshTimer = setTimeout(() => {
      selectedProjectGitRefreshTimer = null
      void get().refreshSelectedProjectGit({ force })
    }, selectedProjectGitRefreshDelayMs)
  }
  const context = { set, get, scheduleSelectedProjectGitRefresh }

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
  attachDesktopDaemonStatusEvents({
    set: useDesktopSessionStore.setState,
    get: useDesktopSessionStore.getState,
  })
  return window.desktop.sessions.onUpdated((view) => {
    useDesktopSessionStore.getState().applySessionUpdate(view)
  })
}
