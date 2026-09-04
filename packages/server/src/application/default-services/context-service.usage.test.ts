import { describe, expect, it } from "vitest";

import { assembleContextUsageSnapshot, type Settings } from "@openharness/core";

import { ContextUsageCache } from "../context-usage-cache.js";
import { createDefaultContextService } from "./context-service.js";
import type { DaemonSettingsRef } from "./shared.js";

function settingsRef(overrides: Partial<Settings> = {}): DaemonSettingsRef {
  return {
    current: {
      model: "test/model",
      apiFormat: "openai",
      provider: "openrouter",
      maxTokens: 1024,
      maxTurns: 10,
      permission: { mode: "default" },
      plugins: { enabled: true },
      memory: { enabled: false },
      sandbox: { enabled: false },
      ...overrides,
    } as Settings,
  };
}

describe("ContextService.usage", () => {
  it("returns conversation_omitted tip without sessionId", async () => {
    const contextService = createDefaultContextService(settingsRef(), new ContextUsageCache());
    const result = await contextService.usage({ cwd: process.cwd() });
    expect(result.snapshot.source).toBe("static_only");
    expect(result.snapshot.tips.some((t) => t.code === "conversation_omitted")).toBe(true);
    expect(result.report).toContain("conversation_omitted");
  });

  it("returns cached snapshot for sessionId when cache warm", async () => {
    const cache = new ContextUsageCache();
    const warmSnapshot = assembleContextUsageSnapshot({
      segments: [{ bucket: "conversation", text: "cached dialog" }],
      model: "cached-model",
      contextWindow: 50_000,
      source: "live_assembly",
    });
    cache.set("s1", warmSnapshot);

    const contextService = createDefaultContextService(settingsRef(), cache);
    const result = await contextService.usage({ cwd: process.cwd(), sessionId: "s1" });

    expect(result.snapshot.source).toBe("session_cache");
    expect(result.snapshot.estimatedInputTokens).toBe(warmSnapshot.estimatedInputTokens);
    expect(result.snapshot.model).toBe("cached-model");
  });

  it("falls back to static_only when session cache is cold", async () => {
    const cache = new ContextUsageCache();
    const contextService = createDefaultContextService(settingsRef(), cache);
    const result = await contextService.usage({ cwd: process.cwd(), sessionId: "missing" });

    expect(result.snapshot.source).toBe("static_only");
    expect(result.snapshot.tips.some((t) => t.code === "conversation_omitted")).toBe(true);
  });
});
