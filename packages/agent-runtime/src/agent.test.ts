import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRunNotAcceptingInputError, type Settings } from "@openharness/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentOperationConflictError, createOpenHarnessAgent } from "./agent.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createOpenHarnessAgent", () => {
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

    const agent = await createOpenHarnessAgent({ cwd, settings });

    expect(agent.id).toMatch(/^agent_session_/);
    expect(agent.subscribe).toBeTypeOf("function");
    expect(agent.children.list()).toEqual([]);
    expect(agent.getHistory()).toEqual([]);
    expect(agent.inspect().tools.length).toBeGreaterThan(0);
    expect(agent.inspect().model).toBe("claude-test");
    expect(agent.getUsage()).toEqual(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
    await agent.close();
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
    const agent = await createOpenHarnessAgent({ cwd, settings });
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
    const agent = await createOpenHarnessAgent({
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
    const agent = await createOpenHarnessAgent({ cwd, settings });
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
    const agent = await createOpenHarnessAgent({
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
    const agent = await createOpenHarnessAgent({
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
