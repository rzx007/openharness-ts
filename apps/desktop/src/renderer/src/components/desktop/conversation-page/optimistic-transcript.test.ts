import { describe, expect, it } from "vitest"

import type { PendingPromptSubmission } from "@renderer/stores/desktop-session/types"
import type { DesktopSessionMessage } from "@shared/session-types"
import { mergeOptimisticTranscript } from "./optimistic-transcript"

const submission: PendingPromptSubmission = {
  id: "input-local",
  sessionId: "session-1",
  content: "new request",
  createdAt: 10,
  phase: "accepted",
  placement: "transcript",
}

describe("mergeOptimisticTranscript", () => {
  it("shows a normal local submission as a user message before the stream confirms it", () => {
    const result = mergeOptimisticTranscript([], [], [submission])

    expect(result.messages).toEqual([
      {
        id: "optimistic-message:input-local",
        sessionId: "session-1",
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        inputId: "input-local",
        metadata: { optimistic: true },
        createdAt: 10,
        updatedAt: 10,
      },
    ])
    expect(result.parts).toEqual([
      {
        id: "optimistic-part:input-local",
        sessionId: "session-1",
        messageId: "optimistic-message:input-local",
        seq: 0,
        type: "text",
        status: "completed",
        text: "new request",
        metadata: { optimistic: true },
        createdAt: 10,
        updatedAt: 10,
      },
    ])
  })

  it("lets an authoritative user message with the same input id take over without duplication", () => {
    const authoritative: DesktopSessionMessage = {
      id: "message-server",
      sessionId: "session-1",
      seq: 3,
      role: "user",
      inputId: "input-local",
      metadata: {},
      createdAt: 11,
      updatedAt: 11,
    }

    const result = mergeOptimisticTranscript([authoritative], [], [submission])

    expect(result.messages).toEqual([authoritative])
    expect(result.parts).toEqual([])
  })
})
