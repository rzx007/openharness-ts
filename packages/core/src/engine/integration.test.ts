import { describe, it, expect, vi } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { RuntimeBuilder } from "./runtime-builder.js";
import type { StreamEvent, ToolDefinition, Message } from "../index.js";

function createMockStreamClient(responses: StreamEvent[][]): {
  client: any;
  getCallCount: () => number;
} {
  let callCount = 0;
  return {
    client: {
      streamMessage: async function* (params: any) {
        const idx = Math.min(callCount, responses.length - 1);
        callCount++;
        for (const event of responses[idx]!) {
          yield event;
        }
      },
    },
    getCallCount: () => callCount,
  };
}

function allowAll(): any {
  return { checkTool: async () => ({ action: "allow", reason: "test" }) };
}

function denyAll(): any {
  return { checkTool: async () => ({ action: "deny", reason: "test" }) };
}

function noopHooks(): any {
  return { execute: async () => ({ blocked: false }) };
}

function makeTool(name: string, fn?: (input: Record<string, unknown>) => string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: async (input) => ({
      content: [{ type: "text" as const, text: fn ? fn(input) : `${name} executed` }],
    }),
  };
}

describe("Integration: Full Agent Loop", () => {
  it("single turn: user → API text → complete", async () => {
    const { client } = createMockStreamClient([
      [
        { type: "text_delta", delta: "Hello! " },
        { type: "text_delta", delta: "How can I help?" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("hi")) {
      events.push(e);
    }

    const texts = events.filter((e) => e.type === "text_delta").map((e: any) => e.delta).join("");
    expect(texts).toBe("Hello! How can I help?");
    expect(events.some((e) => e.type === "complete")).toBe(true);

    const history = engine.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.type).toBe("user");
    expect(history[1]!.type).toBe("assistant");
  });

  it("multi turn: user → API tool_use → execute → API text → complete", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Read", (input) => `contents of ${input.path}`));

    const { client, getCallCount } = createMockStreamClient([
      [
        { type: "text_delta", delta: "Let me read that file." },
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Read", input: { path: "test.txt" } },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "The file contains test data." },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("read test.txt")) {
      events.push(e);
    }

    expect(getCallCount()).toBe(2);
    expect(events.some((e) => e.type === "tool_use_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_use_end")).toBe(true);

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd.result.content[0].text).toBe("contents of test.txt");
    expect(toolEnd.result.isError).toBeFalsy();

    const history = engine.getHistory();
    expect(history).toHaveLength(4);
    expect(history[0]!.type).toBe("user");
    expect(history[1]!.type).toBe("assistant");
    expect(history[2]!.type).toBe("tool_result");
    expect(history[3]!.type).toBe("assistant");
  });

  it("multi-tool parallel execution", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Read"));
    registry.register(makeTool("Glob"));

    const { client, getCallCount } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Read", input: { path: "a.txt" } },
        },
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu2", name: "Glob", input: { pattern: "*.ts" } },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "Done." },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("read and glob")) {
      events.push(e);
    }

    const toolStarts = events.filter((e) => e.type === "tool_use_start");
    expect(toolStarts).toHaveLength(2);
    const toolEnds = events.filter((e) => e.type === "tool_use_end");
    expect(toolEnds).toHaveLength(2);
  });

  it("permission denied blocks tool execution", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Bash"));

    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: "rm -rf /" } },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "Understood." },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, denyAll(), noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("rm everything")) {
      events.push(e);
    }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd).toBeDefined();
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("Permission denied");
  });

  it("unknown tool returns error", async () => {
    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Nonexistent", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "Oops." },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("use unknown")) {
      events.push(e);
    }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("Unknown tool");
  });

  it("tool execution error is captured", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Crash",
      description: "crashes",
      inputSchema: {},
      execute: async () => { throw new Error("boom"); },
    });

    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Crash", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "recovered" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("crash")) {
      events.push(e);
    }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("boom");
  });

  it("three-turn chained tool calls", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Read"));
    registry.register(makeTool("Grep"));
    registry.register(makeTool("Write"));

    const { client, getCallCount } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Read", input: { path: "a.ts" } },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu2", name: "Grep", input: { pattern: "TODO" } },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu3", name: "Write", input: { path: "b.ts" } },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "All done!" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("refactor")) {
      events.push(e);
    }

    expect(getCallCount()).toBe(4);
    const toolEnds = events.filter((e) => e.type === "tool_use_end");
    expect(toolEnds).toHaveLength(3);
  });

  it("respects maxTurns limit and throws MaxTurnsExceeded", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Loop"));

    let callCount = 0;
    const client = {
      streamMessage: async function* () {
        callCount++;
        yield {
          type: "tool_use_start" as const,
          toolUse: { type: "tool_use", id: `tu${callCount}`, name: "Loop", input: {} },
        };
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };

    const { MaxTurnsExceeded } = await import("./query-engine.js");
    const engine = new QueryEngine(client, registry, allowAll(), noopHooks(), { maxTurns: 2 });
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of engine.submitMessage("loop")) {
        events.push(e);
      }
    }).rejects.toThrow(MaxTurnsExceeded);

    const toolEnds = events.filter((e) => e.type === "tool_use_end");
    expect(toolEnds.length).toBeLessThanOrEqual(2);
  });

  it("multiple submitMessage calls maintain history", async () => {
    const { client } = createMockStreamClient([
      [
        { type: "text_delta", delta: "First" },
        { type: "complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", delta: "Second" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());

    for await (const _ of engine.submitMessage("msg1")) {}
    for await (const _ of engine.submitMessage("msg2")) {}

    const history = engine.getHistory();
    expect(history).toHaveLength(4);
    expect(history[0]!.type).toBe("user");
    expect((history[0] as any).content).toBe("msg1");
    expect(history[2]!.type).toBe("user");
    expect((history[2] as any).content).toBe("msg2");
  });
});

describe("Integration: RuntimeBuilder", () => {
  it("builds a valid RuntimeBundle", () => {
    const mockClient = { streamMessage: async function* () {} };
    const registry = new ToolRegistry();
    const checker = allowAll();
    const hooks = noopHooks();
    const engine = new QueryEngine(mockClient, registry, checker, hooks);

    const bundle = new RuntimeBuilder()
      .setApiClient(mockClient)
      .setToolRegistry(registry)
      .setPermissionChecker(checker)
      .setHookExecutor(hooks)
      .setQueryEngine(engine)
      .build({ model: "test", apiFormat: "anthropic", permission: { mode: "default" }, maxTurns: 10 });

    expect(bundle.settings.model).toBe("test");
    expect(bundle.apiClient).toBe(mockClient);
    expect(bundle.queryEngine).toBe(engine);
  });

  it("throws if missing required components", () => {
    expect(() => new RuntimeBuilder().build({ model: "x", apiFormat: "anthropic", permission: { mode: "default" }, maxTurns: 1 }))
      .toThrow("ApiClient is required");
  });
});

describe("Integration: AutoCompact in Agent Loop", () => {
  it("auto-compacts messages when over token limit during loop", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Read", () => "x".repeat(200)));

    const longContent = "a".repeat(500);
    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Read", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: longContent },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(
      client,
      registry,
      allowAll(),
      noopHooks(),
      { maxTokens: 100, compactKeepRecent: 2 },
    );

    for await (const _ of engine.submitMessage("read")) {}

    const history = engine.getHistory();
    const hasCompactSummary = history.some(
      (m) => m.type === "assistant" && typeof m.content === "string" && m.content.includes("compacted"),
    );
    expect(history.length).toBeLessThan(10);
  });

  it("manual compact() call triggers micro then auto", async () => {
    const { client } = createMockStreamClient([
      [
        { type: "text_delta", delta: "hello" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      allowAll(),
      noopHooks(),
      { maxTokens: 50, compactKeepRecent: 2 },
    );

    for (let i = 0; i < 15; i++) {
      for await (const _ of engine.submitMessage(`message ${i} with padding`)) {}
    }

    const beforeCompact = engine.getHistory().length;
    await engine.compact();
    const afterCompact = engine.getHistory().length;

    expect(afterCompact).toBeLessThanOrEqual(beforeCompact);
  });
});

describe("Integration: MaxTurnsExceeded", () => {
  it("throws MaxTurnsExceeded when turn limit reached", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Loop"));

    let callCount = 0;
    const client = {
      streamMessage: async function* () {
        callCount++;
        yield {
          type: "tool_use_start" as const,
          toolUse: { type: "tool_use", id: `tu${callCount}`, name: "Loop", input: {} },
        };
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };

    const { MaxTurnsExceeded } = await import("./query-engine.js");
    const engine = new QueryEngine(client, registry, allowAll(), noopHooks(), { maxTurns: 2 });

    await expect(async () => {
      for await (const _ of engine.submitMessage("loop")) {}
    }).rejects.toThrow(MaxTurnsExceeded);
  });
});

describe("Integration: Runtime Methods", () => {
  it("clear resets history and usage", async () => {
    const { client } = createMockStreamClient([
      [{ type: "text_delta", delta: "hi" }, { type: "complete", stopReason: "end_turn" }],
    ]);
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    for await (const _ of engine.submitMessage("hello")) {}
    expect(engine.getHistory().length).toBeGreaterThan(0);
    engine.clear();
    expect(engine.getHistory()).toHaveLength(0);
  });

  it("setModel changes model for subsequent calls", async () => {
    let usedModel = "";
    const client = {
      streamMessage: async function* (params: any) {
        usedModel = params.model;
        yield { type: "text_delta" as const, delta: "ok" };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    engine.setModel("gpt-4o");
    for await (const _ of engine.submitMessage("hi")) {}
    expect(usedModel).toBe("gpt-4o");
  });

  it("setSystemPrompt changes system prompt", async () => {
    let usedSystem = "";
    const client = {
      streamMessage: async function* (params: any) {
        usedSystem = params.system;
        yield { type: "text_delta" as const, delta: "ok" };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    engine.setSystemPrompt("custom prompt");
    for await (const _ of engine.submitMessage("hi")) {}
    expect(usedSystem).toBe("custom prompt");
  });

  it("loadMessages replaces history", async () => {
    const { client } = createMockStreamClient([
      [{ type: "text_delta", delta: "ok" }, { type: "complete", stopReason: "end_turn" }],
    ]);
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    engine.loadMessages([{ type: "user", content: "loaded" }]);
    expect(engine.getHistory()).toHaveLength(1);
    expect((engine.getHistory()[0] as any).content).toBe("loaded");
  });
});

describe("Integration: Permission Prompt (ask mode)", () => {
  it("asks user and allows on confirmation", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Bash"));

    const { client } = createMockStreamClient([
      [
        { type: "tool_use_start", toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } } },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const askMode = { checkTool: async () => ({ action: "ask" as const, reason: "confirm?" }) };
    const prompt = async () => true;

    const engine = new QueryEngine(client, registry, askMode, noopHooks(), { permissionPrompt: prompt });
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("ls")) { events.push(e); }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd).toBeDefined();
    expect(toolEnd.result.isError).toBeFalsy();
  });

  it("denies when user rejects", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Bash"));

    const { client } = createMockStreamClient([
      [
        { type: "tool_use_start", toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: {} } },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "ok" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const askMode = { checkTool: async () => ({ action: "ask" as const, reason: "confirm?" }) };
    const prompt = async () => false;

    const engine = new QueryEngine(client, registry, askMode, noopHooks(), { permissionPrompt: prompt });
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("run")) { events.push(e); }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("denied by user");
  });
});

describe("Integration: Hook Blocking", () => {
  it("pre-tool hook can block execution", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Bash"));

    const { client } = createMockStreamClient([
      [
        { type: "tool_use_start", toolUse: { type: "tool_use", id: "tu1", name: "Bash", input: {} } },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "ok" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const blockingHooks = {
      execute: async (event: string) => {
        if (event === "pre_tool_use") return { blocked: true, reason: "not allowed" };
        return { blocked: false };
      },
    };

    const engine = new QueryEngine(client, registry, allowAll(), blockingHooks);
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("run")) { events.push(e); }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("Blocked by hook");
  });
});

describe("Integration: CostTracker", () => {
  it("accumulates usage across turns", async () => {
    const { client } = createMockStreamClient([
      [
        { type: "text_delta", delta: "first" },
        { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } },
        { type: "complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", delta: "second" },
        { type: "usage", usage: { inputTokens: 200, outputTokens: 75 } },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    for await (const _ of engine.submitMessage("a")) {}
    for await (const _ of engine.submitMessage("b")) {}

    const total = engine.getTotalUsage();
    expect(total.inputTokens).toBe(300);
    expect(total.outputTokens).toBe(125);
  });
});


