import type { AgentChildResult, AgentRunHandle, AgentRunResult, AgentRunScope } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { AgentChildManager } from "./child-agent.js";
import { AgentEventBus } from "./event-source.js";

describe("AgentChildManager", () => {
  it("owns child identity, execution, events and live directory", async () => {
    const bus = new AgentEventBus();
    const eventTypes: string[] = [];
    bus.subscribe((event) => { eventTypes.push(event.type); });
    const close = vi.fn(async () => {});
    const submitMessage = vi.fn(() => completedRun("child output"));
    const manager = createManager(bus, async () => fakeAgent(submitMessage, close));
    const controller = manager.createController(parentScope());

    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    await expect(invocation.result).resolves.toEqual({ status: "completed", output: "child output" });
    expect(invocation.id).toMatch(/^child_/);
    expect(manager.get(invocation.id)?.sessionId).toBe(invocation.sessionId);
    expect(manager.getBySessionId(invocation.sessionId)?.id).toBe(invocation.id);
    expect(eventTypes).toContain("child.created");

    await manager.closeAll();
    expect(close).toHaveBeenCalledOnce();
    expect(eventTypes).toContain("child.closed");
    expect(manager.list()).toEqual([]);
  });

  it("steers an active child through its framework run handle", async () => {
    const pending = deferred<AgentRunResult>();
    const steer = vi.fn(async (input) => ({ sessionId: "child-session", inputId: input.id!, runId: "run-1" }));
    const submitMessage = vi.fn(() => runHandle(pending.promise, steer));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
      sessionId: "child-session",
    });

    const receipt = await controller.sendChildInput(invocation.id, { id: "steer-1", content: "nudge" });

    expect(receipt).toEqual({ sessionId: "child-session", inputId: "steer-1", runId: "run-1" });
    expect(steer).toHaveBeenCalledWith({ id: "steer-1", content: "nudge" });
    pending.resolve(completedResult("done"));
    await invocation.result;
    await manager.closeAll();
  });

  it("propagates parent abort to the child", async () => {
    const pending = deferred<AgentRunResult>();
    const interrupt = vi.fn(async () => pending.reject(new Error("interrupted")));
    const submitMessage = vi.fn(() => runHandle(pending.promise, vi.fn(), interrupt));
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const parent = new AbortController();
    const invocation = await manager.createController(parentScope(parent.signal)).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    parent.abort();

    await expect(invocation.result).resolves.toMatchObject({ status: "interrupted" });
    expect(interrupt).toHaveBeenCalled();
  });

  it("queues a new run when an active run has stopped accepting steer", async () => {
    const first = deferred<AgentRunResult>();
    const firstRun = runHandle(
      first.promise,
      vi.fn(async () => { throw new Error("Run is not accepting input: run-1"); }),
    );
    const submitMessage = vi.fn()
      .mockReturnValueOnce(firstRun)
      .mockReturnValueOnce({ ...completedRun("second"), id: "run-2", inputId: "input-2" });
    const manager = createManager(new AgentEventBus(), async () => fakeAgent(submitMessage));
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });

    const followUp = controller.sendChildInput(invocation.id, { content: "second" });
    first.resolve(completedResult("first"));

    const receipt = await followUp;
    expect(receipt.runId).toMatch(/^run_/);
    expect(receipt.inputId).toMatch(/^input_/);
    expect(submitMessage).toHaveBeenCalledTimes(2);
    expect(submitMessage.mock.calls[1]?.[1]).toMatchObject({
      ids: { runId: receipt.runId, inputId: receipt.inputId },
    });
    await manager.closeAll();
  });

  it("suspends idle resources and restores history for the next run", async () => {
    const bus = new AgentEventBus();
    const events: string[] = [];
    bus.subscribe((event) => { events.push(event.type); });
    const firstAgent = fakeAgent(vi.fn(() => completedRun("first")));
    firstAgent.getHistory.mockReturnValue([{ type: "assistant", content: "remembered" }]);
    const secondAgent = fakeAgent(vi.fn(() => ({ ...completedRun("second"), id: "run-2", inputId: "input-2" })));
    const createAgent = vi.fn()
      .mockResolvedValueOnce(firstAgent)
      .mockResolvedValueOnce(secondAgent);
    const manager = createManager(bus, createAgent, 5);
    const controller = manager.createController(parentScope());
    const invocation = await controller.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;
    await waitUntil(() => events.includes("child.suspended"));

    await controller.sendChildInput(invocation.id, { content: "continue", delivery: "queue" });

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(secondAgent.loadHistory).toHaveBeenCalledWith([{ type: "assistant", content: "remembered" }]);
    expect(events).toContain("child.resumed");
    await manager.closeAll();
  });

  it("surfaces required child.closed delivery failures and still removes the handle", async () => {
    const bus = new AgentEventBus();
    bus.subscribe((event) => {
      if (event.type === "child.closed") throw new Error("projection unavailable");
    });
    const manager = createManager(bus, async () => fakeAgent(vi.fn(() => completedRun("done"))));
    const invocation = await manager.createController(parentScope()).spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;

    await expect(manager.closeAll()).rejects.toThrow("projection unavailable");
    expect(manager.list()).toEqual([]);
  });
});

function createManager(bus: AgentEventBus, createAgent: () => Promise<any>, idleTtlMs?: number) {
  return new AgentChildManager({
    settings: {} as any,
    cwd: "/repo",
    eventBus: bus,
    idleTtlMs,
    createAgent,
    environment: {
      acquire: async (input) => ({ cwd: input.cwd, release: async () => {} }),
    },
  });
}

function parentScope(signal = new AbortController().signal): AgentRunScope {
  return {
    agentId: "parent",
    sessionId: "parent",
    inputId: "parent-input",
    runId: "parent-run",
    cwd: "/repo",
    traceId: "parent-trace",
    signal,
  };
}

function fakeAgent(submitMessage: any, close = vi.fn(async () => {})) {
  return {
    submitMessage,
    getHistory: vi.fn(() => []),
    loadHistory: vi.fn(),
    close,
  };
}

function completedRun(output: string): AgentRunHandle {
  return runHandle(Promise.resolve(completedResult(output)), vi.fn());
}

function runHandle(
  result: Promise<AgentRunResult>,
  steer: any,
  interrupt = vi.fn(async () => {}),
): AgentRunHandle {
  return {
    id: "run-1",
    inputId: "input-1",
    sessionId: "child-session",
    traceId: "trace-1",
    result,
    steer,
    interrupt,
  };
}

function completedResult(output: string): AgentRunResult {
  return {
    status: "completed",
    output,
    history: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not met");
}
