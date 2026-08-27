import { describe, expect, it } from "vitest"

import {
  acknowledgeOperation,
  beginOperation,
  bindOperationToSession,
  createEmptySessionRuntime,
  failOperation,
  removeOperation,
} from "./operation-state"

describe("desktop session operation state", () => {
  it("replaces only the failed operation with the retried target", () => {
    const runtime = {
      ...createEmptySessionRuntime(),
      operations: {
        "send-old": {
          id: "send-old",
          kind: "send-prompt" as const,
          phase: "failed" as const,
          sessionId: "session-1",
          startedAt: 1,
          finishedAt: 2,
          error: "send failed",
        },
        "edit-old": {
          id: "edit-old",
          kind: "edit-prompt" as const,
          phase: "failed" as const,
          sessionId: "session-1",
          target: "message-1",
          startedAt: 1,
          finishedAt: 2,
          error: "edit failed",
        },
        "edit-other": {
          id: "edit-other",
          kind: "edit-prompt" as const,
          phase: "failed" as const,
          sessionId: "session-1",
          target: "message-2",
          startedAt: 2,
          finishedAt: 3,
          error: "another edit failed",
        },
      },
    }

    const next = beginOperation(runtime, {
      id: "edit-new",
      kind: "edit-prompt",
      sessionId: "session-1",
      target: "message-1",
      startedAt: 3,
    })

    expect(next.operations).toHaveProperty("send-old")
    expect(next.operations).not.toHaveProperty("edit-old")
    expect(next.operations).toHaveProperty("edit-other")
    expect(next.operations["edit-new"]?.phase).toBe("pending")
  })

  it("only settles the operation with the matching id", () => {
    const runtime = createEmptySessionRuntime()
    const first = beginOperation(runtime, {
      id: "op-old",
      kind: "send-prompt",
      sessionId: "session-1",
      startedAt: 1,
    })
    const second = beginOperation(first, {
      id: "op-new",
      kind: "send-prompt",
      sessionId: "session-1",
      startedAt: 2,
    })

    const settled = acknowledgeOperation(second, "op-old", 3)

    expect(settled.operations["op-old"]?.phase).toBe("acknowledged")
    expect(settled.operations["op-new"]?.phase).toBe("pending")
  })

  it("moves a new-conversation operation to the created session", () => {
    const runtime = beginOperation(createEmptySessionRuntime(), {
      id: "op-create",
      kind: "create-session",
      sessionId: null,
      startedAt: 1,
    })

    const moved = bindOperationToSession(runtime, createEmptySessionRuntime(), "op-create", "s1")

    expect(moved.source.operations).toEqual({})
    expect(moved.target.operations["op-create"]).toMatchObject({ sessionId: "s1" })
  })

  it("records failure metadata and removes only its matching operation", () => {
    const runtime = beginOperation(
      beginOperation(createEmptySessionRuntime(), {
        id: "op-failed",
        kind: "send-prompt",
        sessionId: "s1",
        startedAt: 1,
      }),
      {
        id: "op-pending",
        kind: "send-prompt",
        sessionId: "s1",
        startedAt: 2,
      }
    )

    const failed = failOperation(runtime, "op-failed", "request failed", 3)
    const removed = removeOperation(failed, "op-failed")

    expect(failed.operations["op-failed"]).toMatchObject({
      phase: "failed",
      error: "request failed",
      finishedAt: 3,
    })
    expect(removed.operations).not.toHaveProperty("op-failed")
    expect(removed.operations["op-pending"]?.phase).toBe("pending")
  })

  it("keeps the original runtimes when an operation id is not found", () => {
    const source = createEmptySessionRuntime()
    const target = createEmptySessionRuntime()

    expect(acknowledgeOperation(source, "missing", 1)).toBe(source)
    expect(failOperation(source, "missing", "error", 1)).toBe(source)
    expect(removeOperation(source, "missing")).toBe(source)
    const moved = bindOperationToSession(source, target, "missing", "s1")
    expect(moved.source).toBe(source)
    expect(moved.target).toBe(target)
  })
})
