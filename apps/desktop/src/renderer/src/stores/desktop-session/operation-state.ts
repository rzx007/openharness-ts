import type { DesktopOperation, DesktopSessionRuntime } from "./types"

export function createEmptySessionRuntime(): DesktopSessionRuntime {
  return {
    operations: {},
    pendingPromptSubmissions: {},
    pendingPromptEdit: null,
    queuedPromptActions: {},
  }
}

export function beginOperation(
  runtime: DesktopSessionRuntime,
  input: Omit<DesktopOperation, "phase">
): DesktopSessionRuntime {
  const operations = Object.fromEntries(
    Object.entries(runtime.operations).filter(
      ([, operation]) =>
        operation.phase !== "failed" ||
        operation.kind !== input.kind ||
        operation.target !== input.target
    )
  )
  return {
    ...runtime,
    operations: {
      ...operations,
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
