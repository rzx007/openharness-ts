import { describe, expect, it, vi } from "vitest"

vi.mock("streamdown", () => ({
  useIsCodeFenceIncomplete: () => false,
}))

import { CodeBlock } from "@renderer/components/ui/code-block"

import { StreamdownCodeBlock } from "./streamdown-renderers"

describe("StreamdownCodeBlock", () => {
  it("routes a non-Mermaid fence to CodeBlock with its source and language", () => {
    const code = "const answer = 42\n"

    const rendered = StreamdownCodeBlock({
      className: "language-typescript",
      children: code,
    })

    expect(rendered.type).toBe(CodeBlock)
    expect(rendered.props).toMatchObject({
      className: "my-4",
      code: "const answer = 42",
      language: "typescript",
      filename: "typescript",
      showLineNumbers: false,
      renderMode: "highlighted",
    })
  })

  it("renders an oversized fence as plain text", () => {
    const rendered = StreamdownCodeBlock({
      className: "language-typescript",
      children: "x\n".repeat(2_001),
    })

    expect(rendered.type).toBe(CodeBlock)
    expect(rendered.props.renderMode).toBe("plain")
  })
})
