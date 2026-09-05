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
    { id: "system", label: "系统提示", tokens: 100 },
    { id: "tools", label: "工具定义", tokens: 0 },
    { id: "rules", label: "规则", tokens: 0 },
    { id: "skills", label: "技能", tokens: 0 },
    { id: "mcp", label: "MCP 与动态工具", tokens: 0 },
    { id: "subagents", label: "子代理定义", tokens: 0 },
    { id: "summary", label: "对话摘要", tokens: 0 },
    { id: "conversation", label: "对话", tokens: 11_900 },
  ],
  tips: [],
  computedAt: "2026-09-05T00:00:00.000Z",
  source: "session_cache",
}

describe("ContextUsageRing", () => {
  it("does not show a dash placeholder when percentFull is null", () => {
    const html = renderToStaticMarkup(
      createElement(ContextUsageRing, {
        snapshot: { ...base, percentFull: null, contextWindow: null },
      })
    )
    expect(html).toContain('aria-label="上下文占用"')
    expect(html).not.toContain("—")
    expect(html).not.toMatch(/>\s*—\s*</)
  })

  it("keeps an overflow-aware label when percentFull exceeds 100%", () => {
    const html = renderToStaticMarkup(
      createElement(ContextUsageRing, {
        snapshot: { ...base, percentFull: 1.2 },
      })
    )
    expect(html).toContain("120%")
    expect(html).toContain("text-destructive")
  })
})
