import { describe, expect, it } from "vitest"

import { beginScopedOperation, failScopedOperation, removeScopedOperation } from "./error-state"
import type { DesktopOperation } from "./types"

function projectOperation(id: string): Omit<DesktopOperation, "phase"> {
  return {
    id,
    kind: "project-action",
    sessionId: null,
    projectId: "project-1",
    target: "checkout-branch",
    startedAt: 1,
  }
}

describe("scoped operation failures", () => {
  it("keeps a concurrent sibling failure when another same-target operation succeeds", () => {
    const firstStarted = beginScopedOperation({}, projectOperation("operation-a"))
    const bothStarted = beginScopedOperation(firstStarted, projectOperation("operation-b"))
    const firstFailed = failScopedOperation(bothStarted, "operation-a", "first operation failed", 2)

    const afterSecondSucceeded = removeScopedOperation(firstFailed, "operation-b")

    expect(afterSecondSucceeded).toEqual({
      "operation-a": expect.objectContaining({
        phase: "failed",
        error: "first operation failed",
      }),
    })
  })

  it("clears an earlier same-target failure when a new retry begins then succeeds", () => {
    const failed = failScopedOperation(
      beginScopedOperation({}, projectOperation("operation-a")),
      "operation-a",
      "first operation failed",
      2
    )
    const retryStarted = beginScopedOperation(failed, projectOperation("operation-b"))

    const afterRetrySucceeded = removeScopedOperation(retryStarted, "operation-b")

    expect(afterRetrySucceeded).toEqual({})
  })
})
