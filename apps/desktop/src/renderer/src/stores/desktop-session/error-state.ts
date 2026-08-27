import type { DesktopOperation } from "./types"

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  }
  return String(error)
}

export function beginScopedOperation(
  operations: Record<string, DesktopOperation>,
  operation: Omit<DesktopOperation, "phase">
): Record<string, DesktopOperation> {
  return {
    ...removeFailedOperationsForTarget(operations, operation),
    [operation.id]: { ...operation, phase: "pending" },
  }
}

export function failScopedOperation(
  operations: Record<string, DesktopOperation>,
  operationId: string,
  error: string,
  finishedAt: number
): Record<string, DesktopOperation> {
  const operation = operations[operationId]
  if (!operation) return operations
  return {
    ...operations,
    [operationId]: { ...operation, phase: "failed", error, finishedAt },
  }
}

export function removeScopedOperation(
  operations: Record<string, DesktopOperation>,
  operationId: string
): Record<string, DesktopOperation> {
  if (!operations[operationId]) return operations
  const remaining = { ...operations }
  delete remaining[operationId]
  return remaining
}

function removeFailedOperationsForTarget(
  operations: Record<string, DesktopOperation>,
  target: Pick<DesktopOperation, "kind" | "target">
): Record<string, DesktopOperation> {
  return Object.fromEntries(
    Object.entries(operations).filter(
      ([, operation]) =>
        operation.phase !== "failed" ||
        operation.kind !== target.kind ||
        operation.target !== target.target
    )
  )
}
