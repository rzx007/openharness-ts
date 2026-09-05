import { describe, expect, it } from "vitest";

import { formatContextUsageReport } from "./format-report.js";
import type { ContextUsageSnapshot } from "./types.js";

function baseSnapshot(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    model: "test-model",
    contextWindow: 100_000,
    estimatedInputTokens: 1_500,
    percentFull: 0.015,
    estimator: "heuristic_v1",
    buckets: [
      { id: "system", label: "System prompt", tokens: 1_000 },
      { id: "tools", label: "Tool definitions", tokens: 500 },
      { id: "rules", label: "Rules", tokens: 0 },
      { id: "skills", label: "Skills", tokens: 0 },
      { id: "mcp", label: "MCP & dynamic tools", tokens: 0 },
      { id: "subagents", label: "Subagent definitions", tokens: 0 },
      { id: "summary", label: "Summarized conversation", tokens: 0 },
      { id: "conversation", label: "Conversation", tokens: 0 },
    ],
    tips: [{ code: "conversation_omitted", message: "Conversation usage was not included in this snapshot." }],
    computedAt: "2026-09-05T00:00:00.000Z",
    source: "static_only",
    ...overrides,
  };
}

describe("formatContextUsageReport", () => {
  it("includes percent, totals, non-empty buckets, and tips", () => {
    const report = formatContextUsageReport(baseSnapshot());
    expect(report).toContain("1.5% Full");
    expect(report).toContain("~1,500 / 100,000 Tokens");
    expect(report).toContain("System prompt");
    expect(report).toContain("Tool definitions");
    expect(report).not.toContain("Rules:");
    expect(report).toContain("conversation_omitted");
    expect(report).toContain("static_only");
  });

  it("shows placeholder when percentFull is null", () => {
    const report = formatContextUsageReport(
      baseSnapshot({ percentFull: null, contextWindow: null, estimatedInputTokens: 100 }),
    );
    expect(report).toMatch(/n\/a|unavailable|unknown/i);
    expect(report).toContain("~100");
  });
});
