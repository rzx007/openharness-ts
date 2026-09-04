import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"

import { ContextUsageTray } from "./context-usage-tray"

const base: DesktopContextUsageSnapshot = {
  model: "test-model",
  contextWindow: 100_000,
  estimatedInputTokens: 100,
  percentFull: 0.001,
  estimator: "heuristic_v1",
  buckets: [
    { id: "system", label: "System prompt", tokens: 100 },
    { id: "tools", label: "Tool definitions", tokens: 0 },
    { id: "rules", label: "Rules", tokens: 0 },
    { id: "skills", label: "Skills", tokens: 0 },
    { id: "mcp", label: "MCP & dynamic tools", tokens: 0 },
    { id: "subagents", label: "Subagent definitions", tokens: 0 },
    { id: "summary", label: "Summarized conversation", tokens: 0 },
    { id: "conversation", label: "Conversation", tokens: 0 },
  ],
  tips: [{ code: "near_full", message: "Context is nearly full." }],
  computedAt: "2026-09-05T00:00:00.000Z",
  source: "session_cache",
}

describe("ContextUsageTray", () => {
  it("hides zero-token buckets in the tray list", () => {
    const html = renderToStaticMarkup(
      createElement(ContextUsageTray, {
        snapshot: {
          ...base,
          buckets: [
            { id: "system", label: "System prompt", tokens: 100 },
            { id: "tools", label: "Tool definitions", tokens: 0 },
          ],
        },
      })
    )
    expect(html).toContain("System prompt")
    expect(html).not.toContain("Tool definitions")
  })

  it("renders title, percent full, token totals, and tips", () => {
    const html = renderToStaticMarkup(createElement(ContextUsageTray, { snapshot: base }))
    expect(html).toContain("Context")
    expect(html).toContain("0% Full")
    expect(html).toContain("~100 / 100K Tokens")
    expect(html).toContain("Context is nearly full.")
  })
})
