import { describe, expect, it, vi } from "vitest";

import { AgentChildManager, type AgentChildProjection } from "./child-agent.js";

describe("AgentChildManager", () => {
  it("owns child creation, execution and the live invocation handle", async () => {
    const close = vi.fn(async () => {});
    const submitMessage = vi.fn(async function* () {
      yield { type: "text_delta" as const, delta: "child output" };
    });
    const createAgent = vi.fn(async () => ({ submitMessage, close } as any));
    const finishRun = vi.fn(async () => {});
    const projection: AgentChildProjection = {
      createChild: vi.fn(async ({ invocationId }) => ({
        invocationId,
        sessionId: "child-session",
        cwd: "/repo",
        taskId: "task-1",
      })),
      startRun: vi.fn(async (_child, _content, signal) => ({
        runId: "run-1",
        host: {
          scope: {
            sessionId: "child-session",
            inputId: "input-1",
            runId: "run-1",
            cwd: "/repo",
            traceId: "trace-1",
            signal,
          },
          emitEvent: vi.fn(),
          emitStreamEvent: vi.fn(),
          requestPermission: vi.fn(),
        },
      })),
      finishRun,
      closeChild: vi.fn(async () => {}),
    };
    const manager = new AgentChildManager({ settings: {} as any, createAgent });
    const host = manager.createHost({
      scope: {
        sessionId: "parent",
        inputId: "parent-input",
        runId: "parent-run",
        cwd: "/repo",
        traceId: "parent-trace",
        signal: new AbortController().signal,
      },
      emitEvent: vi.fn(),
      emitStreamEvent: vi.fn(),
      requestPermission: vi.fn(),
    }, projection);

    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    await expect(invocation.result).resolves.toEqual({ status: "completed", output: "child output" });
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child-session" }));
    expect(submitMessage).toHaveBeenCalledWith("inspect", expect.objectContaining({ childProjection: projection }));
    expect(finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "child-session" }),
      expect.objectContaining({ runId: "run-1" }),
      { status: "completed", output: "child output" },
    );

    await manager.closeAll();
    expect(close).toHaveBeenCalledOnce();
  });

  it("interrupts framework-owned children when the parent run is interrupted", async () => {
    const close = vi.fn(async () => {});
    const submitMessage = vi.fn(async function* (_content, options) {
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("child interrupted");
    });
    const closeChild = vi.fn(async () => {});
    const projection: AgentChildProjection = {
      createChild: vi.fn(async ({ invocationId }) => ({
        invocationId,
        sessionId: "child-session",
        cwd: "/repo",
      })),
      startRun: vi.fn(async (_child, _content, signal) => ({
        host: {
          scope: {
            sessionId: "child-session",
            inputId: "input-1",
            runId: "run-1",
            cwd: "/repo",
            traceId: "trace-1",
            signal,
          },
          emitEvent: vi.fn(),
          emitStreamEvent: vi.fn(),
          requestPermission: vi.fn(),
        },
      })),
      finishRun: vi.fn(async () => {}),
      closeChild,
    };
    const parent = new AbortController();
    const manager = new AgentChildManager({
      settings: {} as any,
      createAgent: vi.fn(async () => ({ submitMessage, close } as any)),
    });
    const host = manager.createHost({
      scope: {
        sessionId: "parent",
        inputId: "parent-input",
        runId: "parent-run",
        cwd: "/repo",
        traceId: "parent-trace",
        signal: parent.signal,
      },
      emitEvent: vi.fn(),
      emitStreamEvent: vi.fn(),
      requestPermission: vi.fn(),
    }, projection);
    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    parent.abort();

    await expect(invocation.result).resolves.toMatchObject({ status: "interrupted" });
    expect(close).toHaveBeenCalledOnce();
    expect(closeChild).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "child-session" }),
      expect.objectContaining({ status: "interrupted" }),
    );
  });

  it("starts a new serialized run for a completed child by task or agent alias", async () => {
    const submitMessage = vi.fn(async function* (content: string) {
      yield { type: "text_delta" as const, delta: `output:${content}` };
    });
    let runCount = 0;
    const projection = createProjection({
      startRun: vi.fn(async (_child, _input, signal) => {
        runCount += 1;
        return childRun(`run-${runCount}`, signal);
      }),
    });
    const manager = new AgentChildManager({
      settings: {} as any,
      createAgent: vi.fn(async () => ({ submitMessage, close: vi.fn(async () => {}) } as any)),
    });
    const host = manager.createHost(parentHost(), projection);
    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });

    await expect(invocation.result).resolves.toMatchObject({ output: "output:first" });
    await host.sendChildInput("task-1", { content: "second" });
    await expect(host.awaitChildAgent("task-1")).resolves.toMatchObject({ output: "output:second" });
    await host.sendChildInput("Explore@default", { content: "third" });
    await expect(host.awaitChildAgent("Explore@default")).resolves.toMatchObject({ output: "output:third" });
    await Promise.all([
      host.sendChildInput("task-1", { id: "request-4", delivery: "queue", content: "fourth" }),
      host.sendChildInput("task-1", { id: "request-4", delivery: "queue", content: "fourth" }),
    ]);
    await expect(host.awaitChildAgent("task-1")).resolves.toMatchObject({ output: "output:fourth" });
    expect(projection.startRun).toHaveBeenCalledTimes(4);
  });

  it("turns projection start failures into a retryable failed result", async () => {
    const failRunStart = vi.fn(async () => {});
    const startRun = vi.fn()
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockImplementationOnce(async (_child, _input, signal) => childRun("run-2", signal));
    const projection = createProjection({ startRun, failRunStart });
    const manager = new AgentChildManager({
      settings: {} as any,
      createAgent: vi.fn(async () => ({
        submitMessage: vi.fn(async function* () {
          yield { type: "text_delta" as const, delta: "recovered" };
        }),
        close: vi.fn(async () => {}),
      } as any)),
    });
    const host = manager.createHost(parentHost(), projection);
    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });

    await expect(invocation.result).resolves.toMatchObject({ status: "failed", error: "store unavailable" });
    expect(failRunStart).toHaveBeenCalledOnce();
    await host.sendChildInput("task-1", { content: "retry" });
    await expect(host.awaitChildAgent("task-1")).resolves.toMatchObject({ status: "completed", output: "recovered" });
  });

  it("does not start a follow-up while the previous projection is finishing", async () => {
    const finishing = deferred<void>();
    const finishRun = vi.fn(async () => {
      if (finishRun.mock.calls.length === 1) await finishing.promise;
    });
    const startRun = vi.fn(async (_child, _input, signal) => childRun(`run-${startRun.mock.calls.length}`, signal));
    const projection = createProjection({ startRun, finishRun });
    const manager = new AgentChildManager({
      settings: {} as any,
      createAgent: vi.fn(async () => ({
        submitMessage: vi.fn(async function* () {
          yield { type: "text_delta" as const, delta: "done" };
        }),
        close: vi.fn(async () => {}),
      } as any)),
    });
    const host = manager.createHost(parentHost(), projection);
    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    await vi.waitFor(() => expect(finishRun).toHaveBeenCalledOnce());

    const followUp = host.sendChildInput("task-1", { content: "second" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startRun).toHaveBeenCalledOnce();
    finishing.resolve();
    await followUp;
    expect(startRun).toHaveBeenCalledTimes(2);
    await host.awaitChildAgent("task-1");
    await invocation.result;
  });

  it("projects in-flight follow-up input before the child consumes it", async () => {
    const continueRun = deferred<void>();
    const submitMessage = vi.fn(async function* (_content: string, options) {
      yield { type: "text_delta" as const, delta: "start:" };
      await continueRun.promise;
      const followUps = await options.pullFollowUps();
      yield { type: "text_delta" as const, delta: followUps.join(",") };
    });
    const steerRun = vi.fn(async () => ({ inputId: "steered-input" }));
    const projection = createProjection({ steerRun });
    const manager = new AgentChildManager({
      settings: {} as any,
      createAgent: vi.fn(async () => ({
        submitMessage,
        close: vi.fn(async () => {}),
      } as any)),
    });
    const host = manager.createHost(parentHost(), projection);
    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });

    const receipt = await host.sendChildInput("task-1", {
      id: "follow-up-1",
      content: "nudge",
    });
    continueRun.resolve();

    expect(receipt.inputId).toBe("steered-input");
    expect(steerRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "child-session" }),
      expect.objectContaining({ runId: "run-1" }),
      expect.objectContaining({ id: "follow-up-1", content: "nudge", delivery: "steer" }),
    );
    await expect(invocation.result).resolves.toMatchObject({ output: "start:nudge" });
  });

  it("makes concurrent interrupt callers wait for projection settlement", async () => {
    const finishing = deferred<void>();
    const finishRun = vi.fn(async () => {
      await finishing.promise;
    });
    const closeChild = vi.fn(async () => {});
    const projection = createProjection({ finishRun, closeChild });
    const manager = new AgentChildManager({
      settings: {} as any,
      createAgent: vi.fn(async () => ({
        submitMessage: vi.fn(async function* (_content, options) {
          await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("aborted");
        }),
        close: vi.fn(async () => {}),
      } as any)),
    });
    const parent = new AbortController();
    const host = manager.createHost(parentHost(parent.signal), projection);
    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    parent.abort();
    const interrupted = host.interruptChildAgent(invocation.id, "stop");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeChild).not.toHaveBeenCalled();

    finishing.resolve();
    await interrupted;
    expect(closeChild).toHaveBeenCalledOnce();
    expect(finishRun.mock.invocationCallOrder[0]).toBeLessThan(closeChild.mock.invocationCallOrder[0]!);
  });

  it("suspends idle child resources and revives the same session with restored history", async () => {
    const close = vi.fn(async () => {});
    const loadHistory = vi.fn();
    const createAgent = vi.fn(async () => ({
      submitMessage: vi.fn(async function* (content: string) {
        yield { type: "text_delta" as const, delta: content };
      }),
      getHistory: vi.fn(() => [{ role: "assistant", content: [{ type: "text", text: "first" }] }]),
      loadHistory,
      close,
    } as any));
    const manager = new AgentChildManager({ settings: {} as any, idleTtlMs: 1, createAgent });
    const host = manager.createHost(parentHost(), createProjection());
    const invocation = await host.spawnChildAgent({
      description: "Explore",
      prompt: "first",
      agent: "Explore",
      cwd: "/repo",
    });
    await invocation.result;
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    await host.sendChildInput("task-1", { content: "second" });
    await host.awaitChildAgent("task-1");

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(createAgent.mock.calls[1]?.[0]).toMatchObject({ sessionId: "child-session" });
    expect(loadHistory).toHaveBeenCalledWith([
      { role: "assistant", content: [{ type: "text", text: "first" }] },
    ]);
    await manager.closeAll();
  });
});

function parentHost(signal = new AbortController().signal) {
  return {
    scope: {
      sessionId: "parent",
      inputId: "parent-input",
      runId: "parent-run",
      cwd: "/repo",
      traceId: "parent-trace",
      signal,
    },
    emitEvent: vi.fn(),
    emitStreamEvent: vi.fn(),
    requestPermission: vi.fn(),
  };
}

function childRun(runId: string, signal: AbortSignal) {
  return {
    inputId: `input-${runId}`,
    runId,
    host: {
      scope: {
        sessionId: "child-session",
        inputId: `input-${runId}`,
        runId,
        cwd: "/repo",
        traceId: `trace-${runId}`,
        signal,
      },
      emitEvent: vi.fn(),
      emitStreamEvent: vi.fn(),
      requestPermission: vi.fn(),
    },
  };
}

function createProjection(overrides: Partial<AgentChildProjection> = {}): AgentChildProjection {
  return {
    createChild: vi.fn(async ({ invocationId }) => ({
      invocationId,
      sessionId: "child-session",
      cwd: "/repo",
      taskId: "task-1",
    })),
    startRun: vi.fn(async (_child, _input, signal) => childRun("run-1", signal)),
    finishRun: vi.fn(async () => {}),
    closeChild: vi.fn(async () => {}),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = (value) => done(value as T);
  });
  return { promise, resolve };
}
