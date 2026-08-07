import { describe, expect, it, vi } from "vitest";

import { DaemonRuntimeHostPort } from "./daemon-runtime-host.js";

function scope() {
  return {
    sessionId: "s1",
    runId: "run1",
    inputId: "input1",
    cwd: "/repo",
    traceId: "trace1",
    signal: new AbortController().signal,
  };
}

describe("DaemonRuntimeHostPort", () => {
  it("delegates host events and permission decisions", async () => {
    const emitEvent = vi.fn();
    const emitStreamEvent = vi.fn();
    const requestPermission = vi.fn(async () => ({ status: "approved" as const }));
    const childAgentHost = {
      spawnChildAgent: vi.fn(),
      sendChildInput: vi.fn(),
      interruptChildAgent: vi.fn(),
      awaitChildAgent: vi.fn(),
    };
    const host = new DaemonRuntimeHostPort({
      scope: scope(),
      emitEvent,
      emitStreamEvent,
      requestPermission,
      childAgentHost,
    });

    await host.emitEvent({ type: "runtime.event", payload: { ok: true } });
    await host.emitStreamEvent({ type: "text_delta", delta: "hi" });
    const decision = await host.requestPermission({
      toolName: "Write",
      reason: "needs write",
      input: { file_path: "a.txt" },
    });

    expect(emitEvent).toHaveBeenCalledWith({ type: "runtime.event", payload: { ok: true } });
    expect(emitStreamEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "hi" });
    expect(requestPermission).toHaveBeenCalledWith({
      toolName: "Write",
      reason: "needs write",
      input: { file_path: "a.txt" },
    });
    expect(decision.status).toBe("approved");
  });

  it("delegates child-agent lifecycle calls", async () => {
    const invocation = {
      id: "child-invocation",
      taskId: "task-1",
      sessionId: "child-1",
      result: Promise.resolve({ status: "completed" as const, output: "done" }),
    };
    const childAgentHost = {
      spawnChildAgent: vi.fn(async () => invocation),
      sendChildInput: vi.fn(async () => {}),
      interruptChildAgent: vi.fn(async () => {}),
      awaitChildAgent: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
    };
    const host = new DaemonRuntimeHostPort({
      scope: scope(),
      emitEvent: vi.fn(),
      emitStreamEvent: vi.fn(),
      requestPermission: vi.fn(async () => ({ status: "approved" as const })),
      childAgentHost,
    });

    await expect(host.spawnChildAgent({ description: "d", prompt: "p", agent: "a", cwd: "/repo" }))
      .resolves.toBe(invocation);
    await host.sendChildInput("child-invocation", { content: "follow up" });
    await host.interruptChildAgent("child-invocation", "stop");
    await expect(host.awaitChildAgent("child-invocation")).resolves.toEqual({ status: "completed", output: "done" });

    expect(childAgentHost.spawnChildAgent).toHaveBeenCalledWith({ description: "d", prompt: "p", agent: "a", cwd: "/repo" });
    expect(childAgentHost.sendChildInput).toHaveBeenCalledWith("child-invocation", { content: "follow up" });
    expect(childAgentHost.interruptChildAgent).toHaveBeenCalledWith("child-invocation", "stop");
    expect(childAgentHost.awaitChildAgent).toHaveBeenCalledWith("child-invocation");
  });
});
