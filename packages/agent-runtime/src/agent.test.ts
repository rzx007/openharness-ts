import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentRunNotAcceptingInputError,
  RuntimeBundle,
  type Settings,
} from "@openharness/core";
import { McpClientManager } from "@openharness/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentOperationConflictError } from "./agent.js";
import { createDefaultNodeAgent } from "./default-agent.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createDefaultNodeAgent", () => {
  it("constructs a standalone programmatic agent without daemon services", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };

    const agent = await createDefaultNodeAgent({ cwd, settings });

    expect(agent.id).toMatch(/^agent_session_/);
    expect(agent.subscribe).toBeTypeOf("function");
    expect(agent.children.list()).toEqual([]);
    expect(agent.getHistory()).toEqual([]);
    expect(agent.inspect().tools.length).toBeGreaterThan(0);
    expect(agent.inspect().tools).toContainEqual({ name: "Remember" });
    expect(agent.inspect().model).toBe("claude-test");
    expect(agent.getUsage()).toEqual(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
    await agent.close();
  });

  it("closes the runtime exactly once and preserves an extension setup failure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const setupError = new Error("extension setup failed");
    const runtimeClose = vi.spyOn(RuntimeBundle.prototype, "close");

    const creation = createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      extensions: [{ setup: () => { throw setupError; } }],
    });

    await expect(creation).rejects.toBe(setupError);
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("disconnects manager-owned MCP resources when connection setup rejects", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const connectionError = new Error("MCP connection setup failed");
    const resourceClose = vi.fn(async () => {});
    const runtimeClose = vi.spyOn(RuntimeBundle.prototype, "close");
    vi.spyOn(McpClientManager.prototype, "connectAll").mockImplementationOnce(
      async function (servers) {
        const manager = this as unknown as {
          connections: Map<string, unknown>;
          clients: Map<string, { close(): Promise<void> }>;
        };
        manager.connections.set("partial", {
          name: "partial",
          config: servers.partial,
          status: "connecting",
          transport: "stdio",
          authConfigured: false,
          tools: [],
          resources: [],
        });
        manager.clients.set("partial", { close: resourceClose });
        throw connectionError;
      },
    );

    const creation = createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      mcpServers: {
        partial: { type: "stdio", command: "partial-mcp" },
      },
    });

    await expect(creation).rejects.toBe(connectionError);
    expect(resourceClose).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("aggregates creation and cleanup failures in original-first order", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const setupError = new Error("extension setup failed");
    const cleanupError = new Error("runtime cleanup failed");
    const runtimeClose = vi
      .spyOn(RuntimeBundle.prototype, "close")
      .mockRejectedValueOnce(cleanupError);

    const failure = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
      },
      extensions: [{ setup: () => { throw setupError; } }],
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([setupError, cleanupError]);
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("rejects an accepted steer when the run fails before a turn boundary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createDefaultNodeAgent({ cwd, settings });
    (agent as any).runtime.apiClient.streamMessage = async function* () {
      throw new Error("provider failed before boundary");
    };

    const run = agent.submitMessage("hello", {
      ids: { inputId: "input-root", runId: "run-root", traceId: "trace-root" },
    });
    const steer = run.steer({ id: "input-steer", content: "follow up" });

    await expect(run.result).rejects.toThrow("provider failed before boundary");
    await expect(steer).rejects.toBeInstanceOf(AgentRunNotAcceptingInputError);
    await agent.close();
  });

  it("settles concurrent steers one boundary at a time", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createDefaultNodeAgent({
      cwd,
      settings,
      onEvent: (event) => {
        if (event.type === "input.accepted" && event.context.inputId === "input-steer-2") {
          throw new Error("second projection failed");
        }
      },
    });
    (agent as any).runtime.apiClient.streamMessage = async function* () {
      yield { type: "complete", stopReason: "end_turn" };
    };

    const run = agent.submitMessage("hello", {
      ids: { inputId: "input-root", runId: "run-root", traceId: "trace-root" },
    });
    const first = run.steer({ id: "input-steer-1", content: "first" });
    const second = run.steer({ id: "input-steer-2", content: "second" });

    await expect(first).resolves.toEqual({
      sessionId: agent.id,
      inputId: "input-steer-1",
      runId: "run-root",
    });
    await expect(run.result).rejects.toThrow("second projection failed");
    await expect(second).rejects.toBeInstanceOf(AgentRunNotAcceptingInputError);
    await agent.close();
  });

  it("serializes runs, maintenance, context mutation, and close through one lifecycle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createDefaultNodeAgent({ cwd, settings });
    let finishCompact!: () => void;
    (agent as any).runtime.queryEngine.compact = () => new Promise<void>((resolve) => {
      finishCompact = resolve;
    });

    const compact = agent.compact();
    expect(agent.state).toBe("maintaining");
    expect(() => agent.submitMessage("late run")).toThrow(AgentOperationConflictError);
    expect(() => agent.loadHistory([])).toThrow(AgentOperationConflictError);
    expect(() => agent.clear()).toThrow(AgentOperationConflictError);
    expect(() => agent.setModel("other-model")).toThrow(AgentOperationConflictError);

    const closing = agent.close();
    expect(agent.state).toBe("closing");
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishCompact();
    await compact;
    await closing;
    expect(agent.state).toBe("closed");
    expect(() => agent.submitMessage("after close")).toThrow(AgentOperationConflictError);
  });

  it("attempts every cleanup stage and reports failures after becoming closed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
    });
    const childError = new Error("child cleanup failed");
    (agent as any).childManager.closeAll = async () => { throw childError; };
    const runtimeClose = vi.spyOn((agent as any).runtime, "close");

    await expect(agent.close()).rejects.toBe(childError);
    expect(runtimeClose).toHaveBeenCalledOnce();
    expect(agent.state).toBe("closed");
  });

  it("aggregates multiple cleanup failures in lifecycle order", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const agent = await createDefaultNodeAgent({
      cwd,
      settings: {
        apiKey: "test-key",
        apiFormat: "anthropic",
        model: "claude-test",
        maxTurns: 3,
        permission: { mode: "default" },
        sandbox: { enabled: false },
        memory: { enabled: false },
      },
    });
    const childError = new Error("child cleanup failed");
    const eventError = new Error("event drain failed");
    const runtimeError = new Error("runtime cleanup failed");
    (agent as any).childManager.closeAll = vi.fn(async () => { throw childError; });
    (agent as any).eventBus.drain = vi.fn(async () => { throw eventError; });
    (agent as any).runtime.close = vi.fn(async () => { throw runtimeError; });

    const closing = agent.close();
    const failure = await closing.catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([childError, eventError, runtimeError]);
    expect(await agent.close().catch((error) => error)).toBe(failure);
    expect((agent as any).childManager.closeAll).toHaveBeenCalledOnce();
    expect((agent as any).eventBus.drain).toHaveBeenCalledOnce();
    expect((agent as any).runtime.close).toHaveBeenCalledOnce();
    expect(agent.state).toBe("closed");
  });
});
