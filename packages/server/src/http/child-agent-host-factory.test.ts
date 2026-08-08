import { describe, expect, it, vi } from "vitest";

import { DaemonChildAgentHostFactory } from "./child-agent-host-factory.js";

describe("DaemonChildAgentHostFactory", () => {
  it("creates a run-scoped child agent host with the session task bridge", async () => {
    const childSessionHost = {
      createChildSession: vi.fn(async (input: any) => ({
        id: "child-1",
        parentId: input.parentId,
        cwd: input.cwd,
        title: input.title,
        model: "m",
        agent: input.agent,
        status: "idle",
        metadata: input.metadata,
        createdAt: 1,
        updatedAt: 1,
      })),
      admitPrompt: vi.fn(async () => ({ runId: "run-child" })),
      awaitRun: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    const sessionTaskBridge = {
      registerSessionTask: vi.fn(() => ({ id: "task-1" })),
      bindSessionTaskRun: vi.fn(async () => {}),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async () => {}),
    };
    const sessionTaskBridgeManager = {
      createBridge: vi.fn(() => sessionTaskBridge),
    };
    const factory = new DaemonChildAgentHostFactory({
      childSessionHost,
      sessionTaskBridgeManager,
    });

    const host = factory.create({
      scope: {
        sessionId: "parent-1",
        inputId: "input-1",
        runId: "run-1",
        cwd: "/repo",
        traceId: "trace-1",
        signal: new AbortController().signal,
      },
      session: { id: "parent-1", cwd: "/repo" },
    });

    const invocation = await host.spawnChildAgent({
      description: "do work",
      prompt: "hello",
      agent: "worker",
      cwd: "/repo",
    });

    expect(sessionTaskBridgeManager.createBridge).toHaveBeenCalledWith({ id: "parent-1", cwd: "/repo" });
    expect(childSessionHost.createChildSession).toHaveBeenCalledWith(expect.objectContaining({
      parentId: "parent-1",
      cwd: "/repo",
      agent: "worker",
    }));
    expect(invocation).toMatchObject({
      id: expect.stringContaining("child_"),
      taskId: "task-1",
      sessionId: "child-1",
      runId: "run-child",
    });
    await expect(invocation.result).resolves.toEqual({ status: "completed", output: "done" });
    expect(sessionTaskBridge.completeSessionTask).toHaveBeenCalledWith("task-1", { status: "completed", output: "done" });
  });
});
