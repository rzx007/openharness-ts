import { describe, expect, it } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"
import { visibleTranscriptParts } from "./transcript-visibility"

describe("visibleTranscriptParts", () => {
  it("removes reasoning from a read-only child replay without hiding other activity", () => {
    const parts = [
      part("reasoning", "private reasoning"),
      part("text", "visible answer"),
      part("tool", undefined, "read_file"),
      part("tool_result", "visible result"),
      part("error", "visible failure"),
    ]

    const visible = visibleTranscriptParts(parts, false)

    expect(visible.map((item) => item.type)).toEqual(["text", "tool", "tool_result", "error"])
    expect(visible.some((item) => item.text === "private reasoning")).toBe(false)
  })

  it("keeps reasoning in the normal conversation transcript", () => {
    const parts = [part("reasoning", "normal reasoning")]

    expect(visibleTranscriptParts(parts, true)).toBe(parts)
  })
})

function part(
  type: "text" | "reasoning" | "tool" | "tool_result" | "error" | "log",
  text?: string,
  toolName?: string
): DesktopSessionPart {
  return {
    id: `${type}-part`,
    sessionId: "child-session",
    messageId: "message",
    seq: 1,
    type,
    status: "completed",
    ...(text ? { text } : {}),
    ...(toolName ? { toolName } : {}),
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
