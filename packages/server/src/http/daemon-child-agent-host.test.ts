import { describe, expect, it, vi } from "vitest";

import { DaemonChildAgentHost } from "./daemon-child-agent-host.js";

function scope() {
  return {
    sessionId: "parent",
    runId: "run-parent",
    inputId: "input-parent",
    cwd: "/repo",
    traceId: "trace-parent",
    signal: new AbortController().signal,
  };
}

describe("DaemonChildAgentHost", () => {
  it("spawns a child session, projects a task, and resolves the child result", async () => {
    const childSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child-1" })),
      admitPrompt: vi.fn(async () => ({ runId: "run-child" })),
      awaitRun: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    let onInput: ((data: string) => Promise<void>) | undefined;
    const sessionTaskBridge = {
      registerSessionTask: vi.fn((input: { onInput(data: string): Promise<void> }) => {
        onInput = input.onInput;
        return { id: "task-1" };
      }),
      bindSessionTaskRun: vi.fn(async () => {}),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async (_taskId: string, data: string) => {
        await onInput?.(data);
      }),
    };
    const host = new DaemonChildAgentHost({
      scope: scope(),
      childSessionHost,
      sessionTaskBridge,
    });

    const invocation = await host.spawnChildAgent({
      description: "Explore code",
      prompt: "inspect",
      agent: "Explore",
      team: "default",
      cwd: "/repo",
      sessionId: "stable-child",
      systemPrompt: "You are Explore",
      permissionMode: "default",
    });

    expect(invocation).toMatchObject({
      taskId: "task-1",
      sessionId: "child-1",
      runId: "run-child",
    });
    expect(childSessionHost.createChildSession).toHaveBeenCalledWith(expect.objectContaining({
      parentId: "parent",
      id: "stable-child",
      title: "Explore@default",
      agent: "Explore",
      metadata: expect.objectContaining({
        team: "default",
        systemPrompt: "You are Explore",
        permissionMode: "default",
      }),
    }));
    expect(sessionTaskBridge.registerSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "Explore code",
      sessionId: "parent",
      childSessionId: "child-1",
      prompt: "inspect",
    }));
    await expect(invocation.result).resolves.toEqual({ status: "completed", output: "done" });
    await expect(host.awaitChildAgent(invocation.id)).resolves.toEqual({ status: "completed", output: "done" });
    expect(sessionTaskBridge.bindSessionTaskRun).toHaveBeenCalledWith("task-1", "run-child");
    expect(sessionTaskBridge.completeSessionTask).toHaveBeenCalledWith("task-1", {
      status: "completed",
      output: "done",
    });
    expect(childSessionHost.closeRuntime).toHaveBeenCalledWith("child-1");
  });

  it("sends follow-up input to the child session", async () => {
    const childSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child-1" })),
      admitPrompt: vi.fn(async (_sessionId: string, content: string) => ({
        runId: content === "follow up" ? "run-follow-up" : "run-child",
      })),
      awaitRun: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    let onInput: ((data: string) => Promise<void>) | undefined;
    const sessionTaskBridge = {
      registerSessionTask: vi.fn((input: { onInput(data: string): Promise<void> }) => {
        onInput = input.onInput;
        return { id: "task-1" };
      }),
      bindSessionTaskRun: vi.fn(async () => {}),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async (_taskId: string, data: string) => {
        await onInput?.(data);
      }),
    };
    const host = new DaemonChildAgentHost({ scope: scope(), childSessionHost, sessionTaskBridge });
    const invocation = await host.spawnChildAgent({
      description: "Explore code",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    await host.sendChildInput(invocation.id, { content: "follow up" });

    expect(sessionTaskBridge.writeToSessionTask).toHaveBeenCalledWith("task-1", "follow up");
    expect(childSessionHost.admitPrompt).toHaveBeenLastCalledWith("child-1", "follow up");
    expect(sessionTaskBridge.bindSessionTaskRun).toHaveBeenLastCalledWith("task-1", "run-follow-up");
  });

  it("creates isolated child sessions and tasks in a worktree", async () => {
    const worktreeManager = {
      isGitRepo: vi.fn(async () => true),
      create: vi.fn(async () => ({
        slug: "default-build-12345678-abcd",
        path: "/repo/.worktrees/default-build",
        branch: "worktree-default-build",
        created: true,
      })),
      hasChanges: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
    };
    const childSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child-1" })),
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
    const host = new DaemonChildAgentHost({
      scope: scope(),
      childSessionHost,
      sessionTaskBridge,
      createWorktreeManager: vi.fn(async () => worktreeManager),
    });

    const invocation = await host.spawnChildAgent({
      description: "Build code",
      prompt: "implement",
      agent: "Build",
      team: "default",
      cwd: "/repo",
      isolate: true,
    });

    expect(worktreeManager.create).toHaveBeenCalled();
    expect(invocation.worktree).toEqual({
      path: "/repo/.worktrees/default-build",
      branch: "worktree-default-build",
    });
    expect(childSessionHost.createChildSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo/.worktrees/default-build",
      metadata: expect.objectContaining({
        isolate: true,
        worktree: {
          path: "/repo/.worktrees/default-build",
          branch: "worktree-default-build",
        },
      }),
    }));
    expect(sessionTaskBridge.registerSessionTask).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo/.worktrees/default-build",
    }));
  });

  it("interrupts, closes, archives, and completes the task", async () => {
    const childSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child-1" })),
      admitPrompt: vi.fn(async () => ({ runId: "run-child" })),
      awaitRun: vi.fn(() => new Promise(() => {})),
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
    const host = new DaemonChildAgentHost({ scope: scope(), childSessionHost, sessionTaskBridge });
    const invocation = await host.spawnChildAgent({
      description: "Explore code",
      prompt: "inspect",
      agent: "Explore",
      cwd: "/repo",
    });

    await host.interruptChildAgent(invocation.id, "stop");

    expect(childSessionHost.interrupt).toHaveBeenCalledWith("child-1");
    expect(childSessionHost.closeRuntime).toHaveBeenCalledWith("child-1");
    expect(childSessionHost.archive).toHaveBeenCalledWith("child-1");
    expect(sessionTaskBridge.completeSessionTask).toHaveBeenCalledWith("task-1", {
      status: "stopped",
      output: "Child agent stopped",
    });
  });
});
