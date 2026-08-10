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
      expect.objectContaining({ status: "stopped" }),
    );
  });
});
