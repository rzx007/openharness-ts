import { describe, expect, it } from "vitest"

import { analyzePreviewContent, previewLimits, resolvePreviewDecision } from "./file-preview-policy"

describe("analyzePreviewContent", () => {
  it("counts CRLF without including the carriage return in line length", () => {
    expect(analyzePreviewContent("a\r\nbbbb\n")).toEqual({
      characterCount: 8,
      lineCount: 3,
      maxLineLength: 4,
    })
  })

  it("reports one empty line for empty content", () => {
    expect(analyzePreviewContent("")).toEqual({
      characterCount: 0,
      lineCount: 1,
      maxLineLength: 0,
    })
  })
})

describe("resolvePreviewDecision", () => {
  it("keeps a small source file highlighted", () => {
    expect(resolvePreviewDecision("file", "const answer = 42\n")).toMatchObject({
      kind: "file",
      mode: "highlighted",
      reason: null,
    })
  })

  it("degrades a source file one character above the limit", () => {
    const content = "x".repeat(previewLimits.file.characters + 1)

    expect(resolvePreviewDecision("file", content)).toMatchObject({
      mode: "plain",
      reason: "characters",
    })
  })

  it("allows a source file exactly at the character limit", () => {
    const completeLines = `${"x".repeat(39)}\n`.repeat(4_999)
    const content = `${completeLines}${"x".repeat(40)}`

    expect(content).toHaveLength(previewLimits.file.characters)
    expect(resolvePreviewDecision("file", content).mode).toBe("highlighted")
  })

  it("degrades a source file one line above the limit", () => {
    const content = "x\n".repeat(previewLimits.file.lines)

    expect(resolvePreviewDecision("file", content)).toMatchObject({
      mode: "plain",
      reason: "lines",
    })
  })

  it("degrades a source file with a pathological line", () => {
    const content = "x".repeat(previewLimits.file.lineLength + 1)

    expect(resolvePreviewDecision("file", content)).toMatchObject({
      mode: "plain",
      reason: "line-length",
    })
  })

  it("pauses oversized markdown instead of rendering it as plain code", () => {
    const content = "# heading\n".repeat(previewLimits.markdown.lines)

    expect(resolvePreviewDecision("markdown", content).mode).toBe("paused")
  })

  it("uses plain text for an oversized fenced code block and diff", () => {
    const code = "x\n".repeat(previewLimits["code-block"].lines)
    const diff = "+x\n".repeat(previewLimits.diff.lines)

    expect(resolvePreviewDecision("code-block", code).mode).toBe("plain")
    expect(resolvePreviewDecision("diff", diff).mode).toBe("plain")
  })
})
