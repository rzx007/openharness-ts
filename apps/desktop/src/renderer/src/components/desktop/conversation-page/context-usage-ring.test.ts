import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"

import { ContextUsageRing } from "./context-usage-ring"

const base: DesktopContextUsageSnapshot = {
  model: "test-model",
  contextWindow: 100_000,
  estimatedInputTokens: 12_000,
  percentFull: 0.12,
  estimator: "heuristic_v1",
  buckets: [
    { id: "system", label: "System prompt", tokens: 100 },
    { id: "tools", label: "Tool definitions", tokens: 0 },
    { id: "rules", label: "Rules", tokens: 0 },
    { id: "skills", label: "Skills", tokens: 0 },
    { id: "mcp", label: "MCP & dynamic tools", tokens: 0 },
    { id: "subagents", label: "Subagent definitions", tokens: 0 },
    { id: "summary", label: "Summarized conversation", tokens: 0 },
    { id: "conversation", label: "Conversation", tokens: 11_900 },
  ],
  tips: [],
  computedAt: "2026-09-05T00:00:00.000Z",
  source: "session_cache",
}

describe("ContextUsageRing", () => {
  it("shows placeholder when percentFull is null", () => {
    const html = renderToStaticMarkup(
      createElement(ContextUsageRing, {
        snapshot: { ...base, percentFull: null, contextWindow: null },
      })
    )
    expect(html).toMatch(/aria-label="[^"]*[Cc]ontext/)
    expect(html).toContain("—")
  })

  it("renders percent over 100 when percentFull > 1", () => {
    const html = renderToStaticMarkup(
      createElement(ContextUsageRing, {
        snapshot: { ...base, percentFull: 1.2 },
      })
    )
    expect(html).toMatch(/120%/)
  })
})
