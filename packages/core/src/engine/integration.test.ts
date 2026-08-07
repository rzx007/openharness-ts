import { describe, it, expect, vi } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { RuntimeBuilder } from "./runtime-builder.js";
import type { StreamEvent, ToolDefinition, Message } from "../index.js";
import { sanitizeMessageHistory } from "../utils/message-history.js";

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

function makeTool(
  name: string,
  fn?: (input: Record<string, unknown>, context: { cwd: string }) => string,
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    execute: async (input, context) => ({
      content: [{ type: "text" as const, text: fn ? fn(input, context) : `${name} executed` }],
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

  it("uses the configured cwd for tool execution context", async () => {
    const registry = new ToolRegistry();
    const seenCwds: string[] = [];
    registry.register(makeTool("Pwd", (_input, context) => {
      seenCwds.push(context.cwd);
      return context.cwd;
    }));

    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Pwd", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks(), {
      cwd: "/session/project-a",
    });
    for await (const _event of engine.submitMessage("pwd")) {
      // drain
    }

    expect(seenCwds).toEqual(["/session/project-a"]);
  });

  it("uses the configured session id for tool execution context", async () => {
    const registry = new ToolRegistry();
    const seenSessionIds: Array<string | undefined> = [];
    registry.register(makeTool("SessionProbe", (_input, context) => {
      seenSessionIds.push(context.sessionId);
      return context.sessionId ?? "(none)";
    }));

    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "SessionProbe", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks(), {
      cwd: "/session/project-a",
      sessionId: "session-a",
    });
    for await (const _event of engine.submitMessage("session")) {
      // drain
    }

    expect(seenSessionIds).toEqual(["session-a"]);
  });

  it("passes the runtime event sink to tool execution context", async () => {
    const registry = new ToolRegistry();
    const emitted: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    registry.register({
      name: "Emit",
      description: "Emit tool",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input, context) => {
        await context.runtimeHost?.emitEvent({ type: "tool.custom", payload: { ok: true } });
        return { content: [{ type: "text" as const, text: "emitted" }] };
      },
    });

    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Emit", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks());
    for await (const _event of engine.submitMessage("emit", {
      runtimeHost: {
        emitEvent: (event) => emitted.push(event),
        requestPermission: async () => ({ status: "denied" }),
      },
    })) {
      // drain
    }

    expect(emitted).toEqual([{ type: "tool.custom", payload: { ok: true } }]);
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

  it("validates tool input schema before permission checks and execution", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
    registry.register({
      name: "NeedsCommand",
      description: "requires command",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      execute,
    });

    const permissionChecker = { checkTool: vi.fn(async () => ({ action: "allow" as const })) };
    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "NeedsCommand", input: { command: 123 } },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "recovered" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, permissionChecker, noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("run invalid")) {
      events.push(e);
    }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("Tool input validation failed");
    expect(toolEnd.result.content[0].text).toContain("input.command must be string");
    expect(permissionChecker.checkTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
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

  it("injects tool and run abort signals into tool context", async () => {
    const registry = new ToolRegistry();
    let sawAbortSignal = false;
    let runAbortSignal: AbortSignal | undefined;
    registry.register({
      name: "ContextCheck",
      description: "checks context",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input, context) => {
        sawAbortSignal = context.abortSignal instanceof AbortSignal;
        runAbortSignal = context.runAbortSignal;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "ContextCheck", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks());
    const controller = new AbortController();
    for await (const _ of engine.submitMessage("check context", { signal: controller.signal })) {}

    expect(sawAbortSignal).toBe(true);
    expect(runAbortSignal).toBe(controller.signal);
  });

  it("keeps the timeout reason when timeout wins before external abort", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    registry.register({
      name: "Hang",
      description: "never resolves",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input, context) => {
        toolSignal = context.abortSignal;
        return await new Promise(() => {});
      },
    });

    const { client } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Hang", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "done" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(
      client,
      registry,
      allowAll(),
      noopHooks(),
      { toolTimeoutMs: 20 },
    );
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("hang", { signal: controller.signal })) {
      events.push(e);
    }

    const toolEnd = events.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.content[0].text).toContain("Tool execution timed out after 20 ms");
    expect(toolSignal?.aborted).toBe(true);
    const timeoutReason = toolSignal?.reason;
    expect(String(timeoutReason)).toContain("Tool execution timed out after 20 ms");

    controller.abort(new Error("external abort arrived second"));
    expect(toolSignal?.reason).toBe(timeoutReason);
  });

  it("interrupts a hung provider with the submit signal", async () => {
    const controller = new AbortController();
    const interrupted = new Error("provider interrupted");
    let receivedSignal: AbortSignal | undefined;
    const client = {
      streamMessage: async function* (params: { abortSignal?: AbortSignal }) {
        receivedSignal = params.abortSignal;
        params.abortSignal?.throwIfAborted();
        await new Promise<never>((_, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => reject(params.abortSignal?.reason),
            { once: true },
          );
        });
      },
    };
    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());

    const run = (async () => {
      for await (const _ of engine.submitMessage("hang", { signal: controller.signal })) {}
    })();
    controller.abort(interrupted);

    await expect(Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("provider did not abort")), 50)),
    ])).rejects.toBe(interrupted);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("keeps the external reason when external abort wins before timeout", async () => {
    const controller = new AbortController();
    const interrupted = new Error("tool interrupted");
    let toolSignal: AbortSignal | undefined;
    const registry = new ToolRegistry();
    registry.register({
      name: "Hang",
      description: "never resolves",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input, context) => {
        toolSignal = context.abortSignal;
        return await new Promise(() => {});
      },
    });
    let callCount = 0;
    const client = {
      streamMessage: async function* (params: { abortSignal?: AbortSignal }) {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "tool_use_start" as const,
            toolUse: { type: "tool_use" as const, id: "tu1", name: "Hang", input: {} },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }
        params.abortSignal?.throwIfAborted();
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(
      client,
      registry,
      allowAll(),
      noopHooks(),
      { toolTimeoutMs: 10_000 },
    );

    const run = (async () => {
      for await (const _ of engine.submitMessage("hang", { signal: controller.signal })) {}
    })();
    await vi.waitFor(() => expect(toolSignal).toBeDefined());
    controller.abort(interrupted);

    await expect(Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("tool did not abort")), 50)),
    ])).rejects.toBe(interrupted);
    expect(toolSignal?.aborted).toBe(true);
    expect(toolSignal?.reason).toBe(interrupted);
    await Promise.resolve();
    expect(toolSignal?.reason).toBe(interrupted);
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
    const history = engine.getHistory();
    expect(history).toEqual(sanitizeMessageHistory(history));
    expect(history.filter((m) => m.type === "assistant" && m.toolUses?.length)).toHaveLength(2);
    expect(history.filter((m) => m.type === "tool_result")).toHaveLength(2);
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

  it("repairs incomplete parallel tool call history before sending the next request", async () => {
    let sentMessages: Message[] = [];
    const client = {
      streamMessage: async function* (params: { messages: Message[] }) {
        sentMessages = [...params.messages];
        yield { type: "text_delta" as const, delta: "ok" };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };

    const engine = new QueryEngine(client, new ToolRegistry(), allowAll(), noopHooks());
    engine.loadMessages([
      { type: "user", content: "run commands" },
      {
        type: "assistant",
        content: "",
        toolUses: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "hostname" } },
        ],
      },
      { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "cwd" }] },
    ]);

    for await (const _ of engine.submitMessage("continue")) {}

    expect(sentMessages).toEqual([
      { type: "user", content: "run commands" },
      { type: "user", content: "continue" },
    ]);
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

  it("switchApiClient updates the query engine client for subsequent calls", async () => {
    const usedClients: string[] = [];
    const clientA = {
      streamMessage: async function* () {
        usedClients.push("A");
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const clientB = {
      streamMessage: async function* () {
        usedClients.push("B");
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const registry = new ToolRegistry();
    const checker = allowAll();
    const hooks = noopHooks();
    const engine = new QueryEngine(clientA, registry, checker, hooks);

    const bundle = new RuntimeBuilder()
      .setApiClient(clientA)
      .setToolRegistry(registry)
      .setPermissionChecker(checker)
      .setHookExecutor(hooks)
      .setQueryEngine(engine)
      .build({ model: "test", apiFormat: "anthropic", permission: { mode: "default" }, maxTurns: 10 });

    for await (const _ of bundle.queryEngine.submitMessage("before")) {}
    bundle.switchApiClient(clientB);
    for await (const _ of bundle.queryEngine.submitMessage("after")) {}

    expect(bundle.apiClient).toBe(clientB);
    expect(usedClients).toEqual(["A", "B"]);
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

  it("routes auto-compaction through the LLM summarizer (llmCompact is reachable)", async () => {
    // The engine wires its API client into CompactService as the summarizer.
    // A summarization request is identifiable by the summarizer system prompt
    // and a single user message carrying the compaction prompt.
    const compactPrompts: string[] = [];
    const longContent = "padding ".repeat(80);

    const client = {
      streamMessage: async function* (params: any) {
        const isCompactRequest =
          params.system === "You are a conversation summarizer." &&
          Array.isArray(params.messages) &&
          params.messages.length === 1;
        if (isCompactRequest) {
          compactPrompts.push(params.messages[0].content);
          yield { type: "text_delta" as const, delta: "<summary>compacted by llm</summary>" };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }
        // Normal agent turn: emit a long assistant reply to grow the context.
        yield { type: "text_delta" as const, delta: longContent };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };

    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      allowAll(),
      noopHooks(),
      { maxTokens: 100, compactKeepRecent: 2 },
    );

    // Drive several turns so the context crosses the autocompact threshold and
    // the deterministic passes (micro/collapse) are insufficient on their own.
    for (let i = 0; i < 6; i++) {
      for await (const _ of engine.submitMessage(`turn ${i} ${longContent}`)) {}
    }

    // The summarizer (LLM compact path) was actually invoked.
    expect(compactPrompts.length).toBeGreaterThan(0);
    // The LLM-produced summary was inserted into the compacted history.
    const history = engine.getHistory();
    const hasLlmSummary = history.some(
      (m) => m.type === "assistant" && typeof m.content === "string" && m.content.includes("compacted by llm"),
    );
    expect(hasLlmSummary).toBe(true);
    // A compact boundary marker accompanies the full (LLM) compaction.
    const hasBoundary = history.some(
      (m) => typeof m.content === "string" && m.content.includes("[Compact boundary marker]"),
    );
    expect(hasBoundary).toBe(true);
  });

  it("interrupts an in-flight auto-compaction summary with the run signal", async () => {
    const controller = new AbortController();
    const interrupted = new Error("compaction interrupted");
    let compactSignal: AbortSignal | undefined;
    let normalCalls = 0;
    let markCompactStarted!: () => void;
    const compactStarted = new Promise<void>((resolve) => {
      markCompactStarted = resolve;
    });
    const client = {
      streamMessage: async function* (params: any) {
        if (params.system === "You are a conversation summarizer.") {
          compactSignal = params.abortSignal;
          markCompactStarted();
          params.abortSignal?.throwIfAborted();
          await new Promise<never>((_, reject) => {
            params.abortSignal?.addEventListener(
              "abort",
              () => reject(params.abortSignal?.reason),
              { once: true },
            );
          });
          return;
        }
        normalCalls++;
        params.abortSignal?.throwIfAborted();
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      allowAll(),
      noopHooks(),
      { maxTokens: 100, compactKeepRecent: 2 },
    );
    engine.loadMessages([
      { type: "user", content: "old question ".repeat(100) },
      { type: "assistant", content: "old answer ".repeat(100) },
      { type: "user", content: "newer question ".repeat(100) },
      { type: "assistant", content: "newer answer ".repeat(100) },
    ]);

    const run = (async () => {
      for await (const _ of engine.submitMessage("continue", { signal: controller.signal })) {}
    })();
    await compactStarted;
    controller.abort(interrupted);

    await expect(Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("compaction did not abort")), 50)),
    ])).rejects.toBe(interrupted);
    expect(compactSignal).toBe(controller.signal);
    expect(normalCalls).toBe(0);
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
    const engine = new QueryEngine(client, registry, askMode, noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("ls", {
      runtimeHost: {
        emitEvent: async () => {},
        requestPermission: async () => ({ status: "approved" }),
      },
    })) { events.push(e); }

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
    const engine = new QueryEngine(client, registry, askMode, noopHooks());
    const events: StreamEvent[] = [];
    for await (const e of engine.submitMessage("run", {
      runtimeHost: {
        emitEvent: async () => {},
        requestPermission: async () => ({ status: "denied" }),
      },
    })) { events.push(e); }

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

describe("Integration: Steer follow-ups", () => {
  it("injects pullFollowUps at turn boundaries and continues the same run", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Ping", () => "pong"));

    let pullCount = 0;
    const { client, getCallCount } = createMockStreamClient([
      [
        {
          type: "tool_use_start",
          toolUse: { type: "tool_use", id: "tu1", name: "Ping", input: {} },
        },
        { type: "complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", delta: "first reply" },
        { type: "complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", delta: "after steer" },
        { type: "complete", stopReason: "end_turn" },
      ],
    ]);

    const engine = new QueryEngine(client, registry, allowAll(), noopHooks());
    for await (const _ of engine.submitMessage("start", {
      pullFollowUps: () => {
        pullCount++;
        // After tools (1) and before returning from the first text turn (2):
        // inject once when the model would otherwise stop.
        if (pullCount === 2) return ["steered follow-up"];
        return [];
      },
    })) {}

    expect(getCallCount()).toBe(3);
    const history = engine.getHistory();
    expect(history.map((message) => message.type)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[4]).toMatchObject({ type: "user", content: "steered follow-up" });
  });
});


