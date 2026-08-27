import { createInitialDaemonStatus } from "./bootstrap-actions"
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
