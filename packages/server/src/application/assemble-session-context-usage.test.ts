import { describe, expect, it, vi } from "vitest";

import {
  assembleContextUsageSnapshot,
  estimateTokens,
  type Settings,
} from "@openharness/core";

import { assembleSessionContextUsage } from "./assemble-session-context-usage.js";
import { ContextUsageCache } from "./context-usage-cache.js";
import { createDefaultContextService } from "./default-services/context-service.js";
import type { DaemonSettingsRef } from "./default-services/shared.js";

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

function serializeTool(tool: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

describe("assembleSessionContextUsage", () => {
  it("writes usage cache from the same tools list used for the run", async () => {
    const cache = new ContextUsageCache();
    const builtin = {
      name: "Read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      source: { kind: "builtin" as const },
    };
    const mcpTool = {
      name: "mcp__demo__search",
      description: "Search",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      source: { kind: "mcp" as const, id: "demo" },
    };
    const agent = {
      getHistory: () => [
        { type: "user" as const, content: "hello from session" },
      ],
      listModelVisibleTools: () => [builtin, mcpTool],
    };

    const snapshot = await assembleSessionContextUsage({
      sessionId: "s1",
      cwd: process.cwd(),
      model: "test/model",
      settings: settingsRef().current!,
      agent,
      cache,
      contextWindow: 100_000,
    });

    expect(snapshot.source).toBe("live_assembly");
    expect(cache.get("s1")?.source).toBe("live_assembly");

    const toolsTokens = estimateTokens(serializeTool(builtin));
    const mcpTokens = estimateTokens(serializeTool(mcpTool));
    expect(snapshot.buckets.find((b) => b.id === "tools")!.tokens).toBe(toolsTokens);
    expect(snapshot.buckets.find((b) => b.id === "mcp")!.tokens).toBe(mcpTokens);
    expect(snapshot.buckets.find((b) => b.id === "conversation")!.tokens).toBeGreaterThan(0);
  });

  it("invalidates cache on model change", async () => {
    const cache = new ContextUsageCache();
    const snap = assembleContextUsageSnapshot({
      segments: [{ bucket: "conversation", text: "cached" }],
      model: "old-model",
      contextWindow: 50_000,
      source: "live_assembly",
    });
    cache.set("s1", snap);

    const { SessionApplicationService } = await import(
      "./session/session-application-service.js"
    );
    const { DaemonOperationGate } = await import("./control/daemon-operation-gate.js");

    const session = {
      id: "s1",
      cwd: "/repo",
      title: "Session",
      model: "old-model",
      status: "idle",
      metadata: { runtime: { model: "old-model" } },
      createdAt: 1,
      updatedAt: 1,
    };
    const store = {
      getSession: vi.fn(() => session),
      updateSession: vi.fn((_id: string, input: Record<string, unknown>) => ({
        ...session,
        ...input,
      })),
    };
    const agentPool = {
      configured: true,
      close: vi.fn(async () => {}),
      hasActiveWorkForSession: vi.fn(() => false),
    };
    const service = new SessionApplicationService({
      store: store as any,
      runEngine: {
        hasWork: () => false,
        hasActiveRunsForCwd: () => false,
      } as any,
      agentPool: agentPool as any,
      liveChildren: { has: () => false, send: vi.fn(), interrupt: vi.fn() },
      operationGate: new DaemonOperationGate(),
      events: { checkpoint: () => 1, publishSince: vi.fn() },
      contextUsageCache: cache,
    });

    await service.updateSession("s1", {
      metadata: { runtime: { model: "other-model" } },
    });

    expect(cache.get("s1")).toBeUndefined();
  });
});

describe("ContextService.usage live assembly", () => {
  it("reassembles live on refresh when assembleLive is available", async () => {
    const cache = new ContextUsageCache();
    const liveSnap = assembleContextUsageSnapshot({
      segments: [
        { bucket: "tools", text: '{"name":"Read"}' },
        { bucket: "conversation", text: "dialog" },
      ],
      model: "live-model",
      contextWindow: 80_000,
      source: "live_assembly",
    });
    const assembleLive = vi.fn(async () => liveSnap);
    const contextService = createDefaultContextService(
      settingsRef(),
      cache,
      { assembleLive },
    );

    const result = await contextService.usage({
      cwd: process.cwd(),
      sessionId: "s1",
      refresh: true,
    });

    expect(assembleLive).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", cwd: process.cwd() }),
    );
    expect(result.snapshot.source).toBe("live_assembly");
    expect(result.snapshot.buckets.find((b) => b.id === "tools")!.tokens).toBeGreaterThan(0);
  });

  it("falls back to static_only with tip when assembleLive returns null", async () => {
    const cache = new ContextUsageCache();
    const contextService = createDefaultContextService(
      settingsRef(),
      cache,
      { assembleLive: async () => null },
    );

    const result = await contextService.usage({
      cwd: process.cwd(),
      sessionId: "missing",
      refresh: true,
    });

    expect(result.snapshot.source).toBe("static_only");
    expect(result.snapshot.tips.some((t) => t.code === "conversation_omitted")).toBe(true);
  });
});
