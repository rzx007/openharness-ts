import { describe, expect, it } from "vitest"

import {
  createPreviewFile,
  resolveCodeRenderMode,
  resolvePreviewScrollTop,
} from "./virtualized-code-preview-model"
import { resolvePreviewDecision } from "./file-preview-policy"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

describe("resolveCodeRenderMode", () => {
  it("keeps an oversized file plain until the user explicitly overrides it", () => {
    const decision = resolvePreviewDecision("file", "x".repeat(200_001))

    expect(resolveCodeRenderMode(decision, false)).toBe("plain")
    expect(resolveCodeRenderMode(decision, true)).toBe("highlighted")
  })
})

describe("createPreviewFile", () => {
  it("forces the plain path to text even when the filename is TypeScript", () => {
    expect(createPreviewFile(preview("large.ts"), "plain")).toMatchObject({
      name: "large.ts.txt",
      contents: "const answer = 42\n",
      lang: "text",
      cacheKey: "large.ts:18:plain",
    })
  })

  it("preserves the detected language in highlighted mode", () => {
    expect(createPreviewFile(preview("component.tsx"), "highlighted")).toMatchObject({
      name: "component.tsx",
      lang: "tsx",
      cacheKey: "component.tsx:18:highlighted",
    })
  })
})

describe("resolvePreviewScrollTop", () => {
  it("converts a zero-based search line into the virtualizer offset", () => {
    expect(resolvePreviewScrollTop({ searchLine: 100 })).toBe(1_928)
  })

  it("converts a one-based target line without producing a negative offset", () => {
    expect(resolvePreviewScrollTop({ targetLine: 1 })).toBe(0)
  })

  it("prefers the active search match over a target line", () => {
    expect(resolvePreviewScrollTop({ searchLine: 3, targetLine: 200 })).toBe(0)
  })

  it("returns null when there is no active line", () => {
    expect(resolvePreviewScrollTop({})).toBeNull()
  })
})

function preview(path: string): WorkspaceReadFileResult {
  const content = "const answer = 42\n"
  return {
    path,
    name: path,
    language: "typescript",
    size: content.length,
    binary: false,
    content,
  }
}
