import { describe, expect, it } from "vitest"

import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

import { buildConversationEntries } from "./conversation-turn-model"

describe("conversation turn model", () => {
  it("combines all assistant messages from the same input into one turn", () => {
    const messages = [
      message("user", 1, { inputId: "input-1" }),
      message("assistant", 2, { inputId: "input-1", runId: "run-1" }),
      message("assistant", 3, { runId: "run-1" }),
      message("assistant", 4, { inputId: "input-1", runId: "run-1" }),
    ]
    const parts = messages.map((item) => part(item.id, item.seq, `${item.role}-${item.seq}`))
    const entries = buildConversationEntries(messages, parts, [run("run-1", "input-1")])

    expect(entries).toHaveLength(1)
    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    expect(entries[0].turn.assistantMessages).toHaveLength(3)
    expect(entries[0].turn.assistantParts.map((item) => item.text)).toEqual([
      "assistant-2",
      "assistant-3",
      "assistant-4",
    ])
  })

  it("uses user messages as boundaries when relationship ids are absent", () => {
    const messages = [
      message("user", 1),
      message("assistant", 2),
      message("assistant", 3),
      message("user", 4),
      message("assistant", 5),
    ]
    const turns = buildConversationEntries(messages, [], []).flatMap((entry) =>
      entry.type === "turn" ? [entry.turn] : []
    )

    expect(turns).toHaveLength(2)
    expect(turns[0]?.assistantMessages).toHaveLength(2)
    expect(turns[1]?.assistantMessages).toHaveLength(1)
  })

  it("keeps system messages independent", () => {
    const entries = buildConversationEntries(
      [message("system", 1), message("user", 2), message("assistant", 3)],
      [],
      []
    )
    expect(entries.map((entry) => entry.type)).toEqual(["system", "turn"])
  })

  it("creates one assistant-only turn for a partial snapshot", () => {
    const entries = buildConversationEntries(
      [message("assistant", 1, { inputId: "input-1", runId: "run-1" })],
      [],
      [run("run-1", "input-1")]
    )

    if (entries[0]?.type !== "turn") throw new Error("Expected a conversation turn")
    expect(entries[0].turn.assistantMessages).toHaveLength(1)
  })

  it("keeps a failed run with its original user turn when no assistant message exists", () => {
    const failedRun = { ...run("run-1", "input-1"), status: "failed" as const, updatedAt: 2 }
    const entries = buildConversationEntries(
      [message("user", 1, { runId: "run-1" }), message("user", 3, { runId: "run-2" })],
      [],
      [failedRun, run("run-2", "input-2")]
    )
    const turns = entries.flatMap((entry) => (entry.type === "turn" ? [entry.turn] : []))

    expect(turns[0]?.runIds).toContain("run-1")
    expect(turns[1]?.runIds).not.toContain("run-1")
  })

  it("places a failed run without messages by its creation time", () => {
    const failedRun = {
      ...run("orphan-run", "orphan-input"),
      status: "failed" as const,
      createdAt: 2,
      updatedAt: 2,
    }
    const entries = buildConversationEntries(
      [message("user", 1), message("user", 3)],
      [],
      [failedRun]
    )
    const turns = entries.flatMap((entry) => (entry.type === "turn" ? [entry.turn] : []))

    expect(turns.map((turn) => turn.id)).toEqual(["message-1", "orphan-input", "message-3"])
    expect(turns[1]?.runIds).toEqual(["orphan-run"])
  })
})

function message(
  role: DesktopSessionMessage["role"],
  seq: number,
  relationship: Pick<DesktopSessionMessage, "inputId" | "runId"> = {}
): DesktopSessionMessage {
  return {
    id: `message-${seq}`,
    sessionId: "session-1",
    seq,
    role,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
    ...relationship,
  }
}

function part(messageId: string, seq: number, text: string): DesktopSessionPart {
  return {
    id: `part-${seq}`,
    sessionId: "session-1",
    messageId,
    seq: 0,
    type: "text",
    status: "completed",
    text,
    metadata: {},
    createdAt: seq,
    updatedAt: seq,
  }
}

function run(id: string, inputId: string): DesktopSessionRun {
  return {
    id,
    sessionId: "session-1",
    inputId,
    status: "completed",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
