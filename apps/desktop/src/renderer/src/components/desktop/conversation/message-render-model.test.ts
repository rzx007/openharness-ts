import { describe, expect, it } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"

import { collectChangedFiles, parseFileReference } from "./message-render-model"

describe("message render model", () => {
  it("recognizes project files but rejects web links", () => {
    expect(parseFileReference("apps/desktop/src/App.tsx:42")).toEqual({
      path: "apps/desktop/src/App.tsx",
      line: 42,
    })
    expect(parseFileReference("https://example.com/App.tsx")).toBeNull()
  })

  it("collects files and line stats from an apply patch call", () => {
    const part = toolPart("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/App.tsx",
        "-const oldValue = true",
        "+const newValue = true",
        "+const enabled = true",
        "*** Add File: src/new-file.ts",
        "+export const value = 1",
        "*** End Patch",
      ].join("\n"),
    })

    expect(collectChangedFiles([part])).toEqual([
      { path: "src/App.tsx", additions: 2, deletions: 1, hasStats: true },
      { path: "src/new-file.ts", additions: 1, deletions: 0, hasStats: true },
    ])
  })

  it("collects a structured path from a write tool", () => {
    expect(collectChangedFiles([toolPart("write_file", { file_path: "src/output.ts" })])).toEqual([
      { path: "src/output.ts", additions: 0, deletions: 0, hasStats: false },
    ])
  })
})

function toolPart(toolName: string, input: Record<string, unknown>): DesktopSessionPart {
  return {
    id: "part-1",
    sessionId: "session-1",
    messageId: "message-1",
    seq: 1,
    type: "tool",
    status: "completed",
    toolName,
    input,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
