import { describe, expect, it } from "vitest"

import type { PendingPromptSubmission } from "@renderer/stores/desktop-session/types"
import type {
  DesktopSessionInput,
  DesktopSessionMessage,
  DesktopSessionRun,
} from "@shared/session-types"
import { derivePendingHandoffSubmission, mergeOptimisticTranscript } from "./optimistic-transcript"

const submission: PendingPromptSubmission = {
  id: "input-local",
  sessionId: "session-1",
  content: "new request",
  attachments: [],
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

  it("shows a selected skill capsule immediately, including for an empty task", () => {
    const skillInvocation = {
      name: "archify",
      displayName: "Archify",
      source: "project" as const,
      invocationSource: "slash" as const,
    }
    const result = mergeOptimisticTranscript([], [], [{
      ...submission,
      content: "",
      skillInvocation,
    }])

    expect(result.parts).toEqual([
      expect.objectContaining({
        type: "text",
        text: "",
        metadata: { optimistic: true, skillInvocation },
      }),
    ])
  })

  it("renders ordered attachment parts and omits an empty text part", () => {
    const result = mergeOptimisticTranscript(
      [],
      [],
      [
        {
          ...submission,
          content: "",
          attachments: [
            {
              assetId: "asset-b",
              intent: "auto",
              displayName: "b.png",
              mediaType: "image/png",
              sizeBytes: 20,
            },
            {
              assetId: "asset-a",
              intent: "auto",
              displayName: "a.pdf",
              mediaType: "application/pdf",
              sizeBytes: 10,
            },
          ],
        },
      ]
    )

    expect(result.parts).toEqual([
      expect.objectContaining({
        id: "optimistic-attachment:input-local:asset-b:0",
        seq: 0,
        type: "attachment",
        assetId: "asset-b",
        displayName: "b.png",
      }),
      expect.objectContaining({
        id: "optimistic-attachment:input-local:asset-a:1",
        seq: 1,
        type: "attachment",
        assetId: "asset-a",
        displayName: "a.pdf",
      }),
    ])
    expect(result.parts.some((part) => part.type === "text")).toBe(false)
  })
})

describe("derivePendingHandoffSubmission", () => {
  const queuedInput: DesktopSessionInput = {
    id: "input-queued",
    sessionId: "session-1",
    seq: 2,
    delivery: "queue",
    content: "follow-up request",
    attachments: [],
    metadata: {},
    createdAt: 20,
  }
  const queuedRun: DesktopSessionRun = {
    id: "run-queued",
    sessionId: "session-1",
    inputId: queuedInput.id,
    status: "pending",
    metadata: {},
    createdAt: 20,
    updatedAt: 20,
  }

  it("moves the next pending prompt into the transcript while it is being handed off", () => {
    const result = derivePendingHandoffSubmission(
      [],
      [queuedInput],
      [
        {
          id: "run-completed",
          sessionId: "session-1",
          inputId: "input-first",
          status: "completed",
          metadata: {},
          createdAt: 1,
          updatedAt: 19,
        },
        queuedRun,
      ]
    )

    expect(result).toEqual({
      id: "input-queued",
      sessionId: "session-1",
      content: "follow-up request",
      attachments: [],
      createdAt: 20,
      phase: "accepted",
      placement: "transcript",
    })
  })

  it("does not move a queued prompt while another run is still active", () => {
    const result = derivePendingHandoffSubmission(
      [],
      [queuedInput],
      [
        {
          id: "run-active",
          sessionId: "session-1",
          inputId: "input-first",
          status: "running",
          metadata: {},
          createdAt: 1,
          updatedAt: 19,
        },
        queuedRun,
      ]
    )

    expect(result).toBeUndefined()
  })

  it("lets an authoritative user message take over the pending handoff", () => {
    const result = derivePendingHandoffSubmission(
      [
        {
          id: "message-server",
          sessionId: "session-1",
          seq: 3,
          role: "user",
          inputId: queuedInput.id,
          metadata: {},
          createdAt: 21,
          updatedAt: 21,
        },
      ],
      [queuedInput],
      [queuedRun]
    )

    expect(result).toBeUndefined()
  })

  it("does not move a prompt that is being promoted or cancelled", () => {
    const result = derivePendingHandoffSubmission(
      [],
      [queuedInput],
      [queuedRun],
      new Set([queuedRun.id])
    )

    expect(result).toBeUndefined()
  })
})
