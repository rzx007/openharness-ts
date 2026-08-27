import { describe, expect, it } from "vitest"

import type { QueuedPromptAction } from "./desktop-session-store"

describe("desktop session store compatibility exports", () => {
  it("keeps QueuedPromptAction available from the legacy store entry", () => {
    const action: QueuedPromptAction = {
      sessionId: "session-1",
      inputId: "input-1",
      runId: "run-1",
      kind: "promote",
      phase: "pending",
    }

    expect(action.kind).toBe("promote")
  })
})
