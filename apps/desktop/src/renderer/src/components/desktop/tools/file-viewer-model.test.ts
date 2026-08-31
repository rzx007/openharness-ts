import { describe, expect, it } from "vitest"

import { resolveMarkdownRenderMode } from "./file-viewer-model"
import { resolvePreviewDecision } from "./file-preview-policy"

describe("resolveMarkdownRenderMode", () => {
  it("pauses oversized markdown until the user explicitly continues", () => {
    const decision = resolvePreviewDecision("markdown", "x".repeat(300_001))

    expect(resolveMarkdownRenderMode(decision, false)).toBe("paused")
    expect(resolveMarkdownRenderMode(decision, true)).toBe("preview")
  })
})
