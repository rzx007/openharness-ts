import { describe, expect, it, vi } from "vitest";

import { DaemonChildAgentProjection } from "./daemon-child-agent-projection.js";

describe("DaemonChildAgentProjection", () => {
  it("creates durable child records while framework executes the child", async () => {
    const taskBridge = {
      registerSessionTask: vi.fn(() => ({ id: "task-1" })),
      bindSessionTaskRun: vi.fn(async () => {}),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async () => {}),
    };
    const store = {
      admitPrompt: vi.fn(() => ({ id: "input-1" })),
      createRun: vi.fn(() => ({ id: "run-1" })),
      updateRun: vi.fn(),
      appendEvent: vi.fn(),
      listUnboundInputs: vi.fn(() => []),
    };
    const transcriptProjection = {
      beginRun: vi.fn(() => ({})),
      completeOpenTextPart: vi.fn(),
      hasOpenTextPart: vi.fn(() => false),
      projectStreamEvent: vi.fn(() => ({})),
      projectSteeredInputs: vi.fn(),
    };
    const createTaskBridge = vi.fn(() => taskBridge);
    const projection = new DaemonChildAgentProjection({
      store: store as any,
      createChildSession: vi.fn(async () => ({ id: "child-session" })),
      liveChildren: { register: vi.fn(), unregister: vi.fn() },
      createTaskBridge,
      permissionBroker: { ask: vi.fn(async () => true) },
      transcriptProjection: transcriptProjection as any,
      events: { checkpoint: vi.fn(() => 1), publish: vi.fn(), publishSince: vi.fn() },
      traceIdForRun: vi.fn(() => "trace-1"),
      log: vi.fn(),
    });

    const child = await projection.createChild({
      invocationId: "child-1",
      parentScope: {
        sessionId: "parent",
        inputId: "parent-input",
        runId: "parent-run",
        cwd: "/repo",
        traceId: "parent-trace",
        signal: new AbortController().signal,
      },
      spawn: { description: "Explore", prompt: "inspect", agent: "Explore", cwd: "/repo" },
      controls: { send: vi.fn(), interrupt: vi.fn() },
    });
    const run = await projection.startRun(child, { content: "inspect" }, new AbortController().signal);
    await projection.finishRun(child, run, { status: "completed", output: "done" });

    expect(child).toMatchObject({ sessionId: "child-session", taskId: "task-1" });
    expect(store.admitPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child-session" }));
    expect(store.createRun).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child-session" }));
    expect(taskBridge.bindSessionTaskRun).toHaveBeenCalledWith("task-1", "run-1");
    expect(taskBridge.completeSessionTask).toHaveBeenCalledWith("task-1", {
      status: "completed",
      output: "done",
    });

    const grandchild = await projection.createChild({
      invocationId: "grandchild-1",
      parentScope: {
        sessionId: "child-session",
        inputId: "child-input",
        runId: "child-run",
        cwd: "/child-repo",
        traceId: "child-trace",
        signal: new AbortController().signal,
      },
      spawn: { description: "Verify", prompt: "verify", agent: "Verify", cwd: "/child-repo" },
      controls: { send: vi.fn(), interrupt: vi.fn() },
    });
    await projection.startRun(grandchild, { content: "verify" }, new AbortController().signal);

    expect(createTaskBridge).toHaveBeenLastCalledWith({ id: "child-session", cwd: "/child-repo" });
    expect(store.admitPrompt).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ parentRunId: "child-run" }),
    }));
  });
});
