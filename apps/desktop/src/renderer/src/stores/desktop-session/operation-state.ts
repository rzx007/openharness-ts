import type { DesktopOperation, DesktopSessionRuntime } from "./types"

export interface LegacySessionRuntimeMirror {
  sending: boolean
  sendingOperationId: string | null
  pendingPromptSubmissions: DesktopSessionRuntime["pendingPromptSubmissions"]
  pendingPromptEdit: DesktopSessionRuntime["pendingPromptEdit"]
  queuedPromptActions: DesktopSessionRuntime["queuedPromptActions"]
}

export function createEmptySessionRuntime(): DesktopSessionRuntime {
  return {
    operations: {},
    pendingPromptSubmissions: {},
    pendingPromptEdit: null,
    queuedPromptActions: {},
  }
}

export function projectRuntimeToLegacyMirror(
  runtime: DesktopSessionRuntime,
  options: { includeCreateSession?: boolean } = {}
): LegacySessionRuntimeMirror {
  const composerOperation = Object.values(runtime.operations).find(
    (operation) =>
      operation.phase === "pending" &&
      (operation.kind === "send-prompt" ||
        operation.kind === "invoke-command" ||
        operation.kind === "edit-prompt" ||
        (options.includeCreateSession && operation.kind === "create-session"))
  )
  return {
    sending: Boolean(composerOperation),
    sendingOperationId: composerOperation?.id ?? null,
    pendingPromptSubmissions: runtime.pendingPromptSubmissions,
    pendingPromptEdit: runtime.pendingPromptEdit,
    queuedPromptActions: runtime.queuedPromptActions,
  }
}

export function beginOperation(
  runtime: DesktopSessionRuntime,
  input: Omit<DesktopOperation, "phase">
): DesktopSessionRuntime {
  return {
    ...runtime,
    operations: {
      ...runtime.operations,
      [input.id]: { ...input, phase: "pending" },
    },
  }
}

export function acknowledgeOperation(
  runtime: DesktopSessionRuntime,
  operationId: string,
  finishedAt: number
): DesktopSessionRuntime {
  return updateOperation(runtime, operationId, (operation) => ({
    ...operation,
    phase: "acknowledged",
    finishedAt,
    error: undefined,
  }))
}

export function failOperation(
  runtime: DesktopSessionRuntime,
  operationId: string,
  error: string,
  finishedAt: number
): DesktopSessionRuntime {
  return updateOperation(runtime, operationId, (operation) => ({
    ...operation,
    phase: "failed",
    error,
    finishedAt,
  }))
}

export function removeOperation(
  runtime: DesktopSessionRuntime,
  operationId: string
): DesktopSessionRuntime {
  if (!runtime.operations[operationId]) return runtime

  const operations = { ...runtime.operations }
  delete operations[operationId]
  return { ...runtime, operations }
}

export function bindOperationToSession(
  source: DesktopSessionRuntime,
  target: DesktopSessionRuntime,
  operationId: string,
  sessionId: string
): { source: DesktopSessionRuntime; target: DesktopSessionRuntime } {
  const operation = source.operations[operationId]
  if (!operation) return { source, target }

  const sourceOperations = { ...source.operations }
  delete sourceOperations[operationId]
  return {
    source: { ...source, operations: sourceOperations },
    target: {
      ...target,
      operations: {
        ...target.operations,
        [operationId]: { ...operation, sessionId },
      },
    },
  }
}

function updateOperation(
  runtime: DesktopSessionRuntime,
  operationId: string,
  update: (operation: DesktopOperation) => DesktopOperation
): DesktopSessionRuntime {
  const operation = runtime.operations[operationId]
  if (!operation) return runtime

  return {
    ...runtime,
    operations: {
      ...runtime.operations,
      [operationId]: update(operation),
    },
  }
}
