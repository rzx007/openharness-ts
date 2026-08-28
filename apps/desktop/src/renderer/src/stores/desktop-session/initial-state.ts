import type { DesktopDaemonStatus } from "@shared/session-types"

import { createEmptySessionRuntime } from "./operation-state"
import type {
  BootstrapActions,
  DesktopRuntimeState,
  DesktopSessionState,
  ProjectActions,
  PromptActions,
  QueuedPromptActions,
  SessionActions,
} from "./types"

const initialDaemonStatus: DesktopDaemonStatus = {
  phase: "idle",
  message: "等待连接 daemon",
  updatedAt: Date.now(),
}

function createInitialDaemonStatus(): DesktopDaemonStatus {
  return initialDaemonStatus
}

export function createInitialRuntimeState(): DesktopRuntimeState {
  return {
    appOperations: {},
    projectOperations: {},
    newConversationRuntime: createEmptySessionRuntime(),
    sessionRuntimes: {},
  }
}

export function createInitialState(): Omit<
  DesktopSessionState,
  | keyof BootstrapActions
  | keyof ProjectActions
  | keyof SessionActions
  | keyof PromptActions
  | keyof QueuedPromptActions
  | "applySessionUpdate"
> {
  return {
    loadStatus: "idle" as const,
    daemonStatus: createInitialDaemonStatus(),
    projects: [],
    sessions: [],
    archivedSessions: [],
    models: [],
    attachmentSupport: {
      daemonSupported: false,
      interactionEnabled: false,
      uploadModes: [],
      limits: null,
    },
    defaultModel: null,
    defaultProvider: null,
    defaultPermissionMode: "default" as const,
    selectedModel: null,
    selectedProvider: null,
    selectedPermissionMode: "default" as const,
    workspaceMode: "project" as const,
    selectedProject: null,
    selectedProjectGit: false,
    selectedProjectGitCheckedAt: null,
    branch: null,
    branches: [],
    activeSessionId: null,
    sessionView: null,
    ...createInitialRuntimeState(),
  }
}
