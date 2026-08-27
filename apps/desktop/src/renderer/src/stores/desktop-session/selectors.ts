import { createEmptySessionRuntime } from "./operation-state"
import type {
  DesktopOperation,
  DesktopOperationKind,
  DesktopSessionRuntime,
  DesktopSessionState,
} from "./types"

const emptySessionRuntime = createEmptySessionRuntime()

const composerOperationKinds = new Set<DesktopOperationKind>([
  "send-prompt",
  "invoke-command",
  "edit-prompt",
])

const sessionErrorOperationKinds = new Set<DesktopOperationKind>([
  "open-session",
  "invoke-command",
  "edit-prompt",
  "interrupt-run",
  "reply-permission",
])

export function selectDaemonStatus(
  state: DesktopSessionState
): DesktopSessionState["daemonStatus"] {
  return state.daemonStatus
}

export function selectLoadStatus(state: DesktopSessionState): DesktopSessionState["loadStatus"] {
  return state.loadStatus
}

export function selectProjects(state: DesktopSessionState): DesktopSessionState["projects"] {
  return state.projects
}

export function selectSessions(state: DesktopSessionState): DesktopSessionState["sessions"] {
  return state.sessions
}

export function selectArchivedSessions(
  state: DesktopSessionState
): DesktopSessionState["archivedSessions"] {
  return state.archivedSessions
}

export function selectActiveSessionId(
  state: DesktopSessionState
): DesktopSessionState["activeSessionId"] {
  return state.activeSessionId
}

export function selectActiveSessionRuntime(state: DesktopSessionState): DesktopSessionRuntime {
  return selectSessionRuntime(state, state.activeSessionId)
}

export function selectSessionRuntime(
  state: DesktopSessionState,
  sessionId: string | null
): DesktopSessionRuntime {
  return sessionId ? (state.sessionRuntimes[sessionId] ?? emptySessionRuntime) : emptySessionRuntime
}

export function selectNewConversationSending(state: DesktopSessionState): boolean {
  return hasPendingOperation(state.newConversationRuntime, "create-session")
}

export function selectSessionSending(state: DesktopSessionState, sessionId: string): boolean {
  const runtime = selectSessionRuntime(state, sessionId)
  return hasPendingComposerOperation(runtime) || hasSubmittingPrompt(runtime)
}

export function selectActiveSessionSending(state: DesktopSessionState): boolean {
  return state.activeSessionId ? selectSessionSending(state, state.activeSessionId) : false
}

export function selectActiveSessionOpening(state: DesktopSessionState): boolean {
  return Boolean(
    state.activeSessionId &&
    hasPendingOperation(selectSessionRuntime(state, state.activeSessionId), "open-session")
  )
}

export function selectActiveSessionPromptSubmissions(
  state: DesktopSessionState
): DesktopSessionRuntime["pendingPromptSubmissions"] {
  return selectActiveSessionRuntime(state).pendingPromptSubmissions
}

export function selectActiveSessionQueuedPromptActions(
  state: DesktopSessionState
): DesktopSessionRuntime["queuedPromptActions"] {
  return selectActiveSessionRuntime(state).queuedPromptActions
}

export function selectSessionComposerError(
  state: DesktopSessionState,
  sessionId: string
): string | null {
  const runtime = selectSessionRuntime(state, sessionId)
  return selectLatestOperationError(runtime.operations, (operation) =>
    sessionErrorOperationKinds.has(operation.kind)
  )
}

export function selectActiveSessionComposerError(state: DesktopSessionState): string | null {
  return state.activeSessionId ? selectSessionComposerError(state, state.activeSessionId) : null
}

export function selectNewConversationError(state: DesktopSessionState): string | null {
  return selectLatestOperationError(
    state.newConversationRuntime.operations,
    (operation) => operation.kind === "create-session"
  )
}

export function selectAppOperationError(state: DesktopSessionState): string | null {
  return selectLatestOperationError(
    state.appOperations,
    (operation) => operation.target === "initialize" || operation.target === "choose-project"
  )
}

export function selectProjectOperationError(
  state: DesktopSessionState,
  projectId: string | null
): string | null {
  return projectId
    ? selectLatestOperationError(state.projectOperations[projectId] ?? {}, () => true)
    : null
}

function hasPendingComposerOperation(runtime: DesktopSessionRuntime): boolean {
  return hasPendingOperation(runtime, (kind) => composerOperationKinds.has(kind))
}

function hasSubmittingPrompt(runtime: DesktopSessionRuntime): boolean {
  return Object.values(runtime.pendingPromptSubmissions).some(
    (submission) => submission.phase === "submitting"
  )
}

function hasPendingOperation(
  runtime: DesktopSessionRuntime,
  kind: DesktopOperationKind | ((kind: DesktopOperationKind) => boolean)
): boolean {
  return Object.values(runtime.operations).some(
    (operation) =>
      operation.phase === "pending" &&
      (typeof kind === "function" ? kind(operation.kind) : operation.kind === kind)
  )
}

function selectLatestOperationError(
  operations: Record<string, DesktopOperation>,
  matches: (operation: DesktopOperation) => boolean
): string | null {
  let latest: DesktopOperation | null = null
  for (const operation of Object.values(operations)) {
    if (
      operation.phase === "failed" &&
      operation.error &&
      matches(operation) &&
      (!latest ||
        (operation.finishedAt ?? operation.startedAt) >= (latest.finishedAt ?? latest.startedAt))
    ) {
      latest = operation
    }
  }
  return latest?.error ?? null
}
