import { describe, it, expect, vi } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { CompactService } from "./compact-service.js";
import { loadSettings, saveSettings } from "../config/settings.js";
import type { StreamEvent, ToolDefinition } from "../index.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function createMockStreamClient(events: StreamEvent[]): any {
  return {
    streamMessage: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createMockPermissionChecker(allow = true): any {
  return {
    checkTool: async () => ({
      action: allow ? "allow" : "deny",
      reason: "mock",
    }),
  };
}

function createMockHookExecutor(): any {
  return {
    execute: async () => ({ blocked: false }),
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: "test",
      description: "test tool",
      inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    registry.register(tool);
    expect(registry.get("test")).toBe(tool);
    expect(registry.has("test")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });

  it("getAll returns all tools", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "", inputSchema: {}, execute: async () => ({ content: [] }) });
    registry.register({ name: "b", description: "", inputSchema: {}, execute: async () => ({ content: [] }) });
    expect(registry.getAll()).toHaveLength(2);
  });
});

describe("QueryEngine", () => {
  it("yields text_delta events for simple response", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "Hello" },
      { type: "complete", stopReason: "end_turn" },
    ];
    const engine = new QueryEngine(
      createMockStreamClient(events),
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor()
    );

    const collected: StreamEvent[] = [];
    for await (const event of engine.submitMessage("hi")) {
      collected.push(event);
    }

    expect(collected.some((e) => e.type === "text_delta")).toBe(true);
    expect(collected.some((e) => e.type === "complete")).toBe(true);
  });

  it("returns history after submit", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "response" },
      { type: "complete", stopReason: "end_turn" },
    ];
    const engine = new QueryEngine(
      createMockStreamClient(events),
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor()
    );

    for await (const _ of engine.submitMessage("hi")) {}
    const history = engine.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.type).toBe("user");
    expect(history[1]!.type).toBe("assistant");
  });

  it("executes tool calls", async () => {
    const tool: ToolDefinition = {
      name: "Echo",
      description: "echoes input",
      inputSchema: {},
      execute: async (input) => ({
        content: [{ type: "text", text: `echo: ${input.text ?? ""}` }],
      }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const callEvents: StreamEvent[] = [
      { type: "text_delta", delta: "let me check" },
      {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "tu1", name: "Echo", input: { text: "hello" } },
      },
      { type: "complete", stopReason: "tool_use" },
    ];
    const doneEvents: StreamEvent[] = [
      { type: "text_delta", delta: "done" },
      { type: "complete", stopReason: "end_turn" },
    ];

    let callCount = 0;
    const client = {
      streamMessage: async function* () {
        callCount++;
        const evts = callCount === 1 ? callEvents : doneEvents;
        for (const e of evts) yield e;
      },
    };

    const engine = new QueryEngine(
      client,
      registry,
      createMockPermissionChecker(),
      createMockHookExecutor()
    );

    const collected: StreamEvent[] = [];
    for await (const event of engine.submitMessage("use echo")) {
      collected.push(event);
    }

    expect(collected.some((e) => e.type === "tool_use_start")).toBe(true);
    expect(collected.some((e) => e.type === "tool_use_end")).toBe(true);
  });

  it("denies tool when permission denied", async () => {
    const tool: ToolDefinition = {
      name: "Danger",
      description: "dangerous",
      inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: StreamEvent[] = [
      {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "tu1", name: "Danger", input: {} },
      },
      { type: "complete", stopReason: "tool_use" },
    ];
    const doneEvents: StreamEvent[] = [
      { type: "text_delta", delta: "ok" },
      { type: "complete", stopReason: "end_turn" },
    ];

    let callCount = 0;
    const client = {
      streamMessage: async function* () {
        callCount++;
        for (const e of callCount === 1 ? events : doneEvents) yield e;
      },
    };

    const engine = new QueryEngine(
      client,
      registry,
      createMockPermissionChecker(false),
      createMockHookExecutor()
    );

    const collected: StreamEvent[] = [];
    for await (const event of engine.submitMessage("use danger")) {
      collected.push(event);
    }

    const toolEnd = collected.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd).toBeDefined();
    expect(toolEnd.result.isError).toBe(true);
  });
});

describe("CompactService", () => {
  it("returns messages unchanged when under token limit", async () => {
    const svc = new CompactService(100_000);
    const msgs = [
      { type: "user" as const, content: "short" },
    ];
    expect(await svc.autoCompact(msgs)).toEqual(msgs);
  });

  it("compacts when over limit", async () => {
    const svc = new CompactService(10, 2);
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      type: "user" as const,
      content: `This is message number ${i} with some padding to use tokens`,
    }));
    const result = await svc.autoCompact(msgs);
    expect(result.length).toBeLessThan(msgs.length);
  });

  it("preserves system messages", async () => {
    const svc = new CompactService(10, 2);
    const msgs = [
      { type: "system" as const, content: "system prompt" },
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "user" as const,
        content: `msg ${i} with enough content to fill tokens`,
      })),
    ];
    const result = await svc.autoCompact(msgs);
    expect(result[0]!.type).toBe("system");
  });

  it("microCompact replaces tool results with placeholders", () => {
    const svc = new CompactService();
    const msgs = [
      { type: "user" as const, content: "hi" },
      { type: "tool_result" as const, toolUseId: "tu1", content: [{ type: "text" as const, text: "long output..." }] },
    ];
    const result = svc.microCompact(msgs);
    expect(result[0]!.type).toBe("user");
    expect(result[1]!.type).toBe("tool_result");
  });

  it("estimateTokens returns reasonable estimate", () => {
    const svc = new CompactService();
    const msgs = [
      { type: "user" as const, content: "hello world" },
    ];
    const tokens = svc.estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });
});

describe("loadSettings", () => {
  it("returns default settings with no overrides", async () => {
    const settings = await loadSettings();
    expect(settings.model).toBe("claude-sonnet-4-20250514");
    expect(settings.apiFormat).toBe("anthropic");
    expect(settings.permission.mode).toBe("default");
    expect(settings.maxTurns).toBe(50);
  });

  it("applies cli overrides", async () => {
    const settings = await loadSettings({ model: "gpt-4o", maxTurns: 10 });
    expect(settings.model).toBe("gpt-4o");
    expect(settings.maxTurns).toBe(10);
  });
});
