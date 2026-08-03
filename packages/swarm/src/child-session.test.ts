import { describe, expect, it, vi } from "vitest";

import { ChildSessionBackend, type ChildSessionHost, type SessionTaskBridge } from "./child-session.js";
import type { TeammateSpawnConfig } from "./index.js";
import type { WorktreeManager } from "./worktree.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function config(overrides: Partial<TeammateSpawnConfig> = {}): TeammateSpawnConfig {
  return {
    name: "Explore",
    team: "default",
    prompt: "inspect",
    cwd: "/repo",
    parentSessionId: "parent",
    model: "m",
    ...overrides,
  };
}

describe("ChildSessionBackend", () => {
  it("creates a child session, bridges its run to a task, and supports follow-ups", async () => {
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => ({ runId: "run-1" })),
      awaitRun: vi.fn(async () => ({ status: "completed", output: "done" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    let callbacks:
      | { onInput(data: string): Promise<void>; onStop(): Promise<void> }
      | undefined;
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn((input) => {
        callbacks = input;
        return { id: "task-1" };
      }),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async (_taskId, data) => callbacks!.onInput(data)),
    };
    const backend = new ChildSessionBackend({ host, taskBridge: bridge });

    const spawned = await backend.spawn(config());

    expect(host.createChildSession).toHaveBeenCalledWith(expect.objectContaining({
      parentId: "parent",
      cwd: "/repo",
      model: "m",
      agent: "Explore",
    }));
    expect(host.admitPrompt).toHaveBeenCalledWith("child", "inspect");
    expect(spawned).toMatchObject({
      success: true,
      agentId: "Explore@default",
      taskId: "task-1",
      sessionId: "child",
      backendType: "in_process",
    });

    await vi.waitFor(() => {
      expect(bridge.completeSessionTask).toHaveBeenCalledWith("task-1", {
        status: "completed",
        output: "done",
      });
      expect(host.closeRuntime).toHaveBeenCalledWith("child");
    });
    expect((bridge.completeSessionTask as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (host.closeRuntime as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(host.archive).not.toHaveBeenCalled();

    await backend.sendMessage("Explore@default", { text: "follow up", fromAgent: "coordinator" });
    expect(bridge.writeToSessionTask).toHaveBeenCalledWith("task-1", "follow up");
    expect(host.admitPrompt).toHaveBeenLastCalledWith("child", "follow up");
  });

  it("interrupts and archives the mapped child when terminated", async () => {
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => ({ runId: "run-1" })),
      awaitRun: vi.fn(async () => ({ status: "completed", output: "" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn(() => ({ id: "task-1" })),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async () => {}),
    };
    const backend = new ChildSessionBackend({ host, taskBridge: bridge });
    await backend.spawn(config());

    await backend.terminate("Explore@default");

    expect(host.interrupt).toHaveBeenCalledWith("child");
    expect(host.closeRuntime).toHaveBeenCalledWith("child");
    expect(host.archive).toHaveBeenCalledWith("child");
    expect((host.interrupt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (host.closeRuntime as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect((host.closeRuntime as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (host.archive as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(bridge.completeSessionTask).toHaveBeenCalledWith("task-1", {
      status: "stopped",
      output: "Child session terminated",
    });
    await expect(backend.terminate("Explore@default")).rejects.toThrow("No active child session");
  });

  it("fails the bridged task when a follow-up cannot be admitted", async () => {
    let admitCount = 0;
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => {
        admitCount += 1;
        if (admitCount > 1) throw new Error("child archived");
        return { runId: "run-1" };
      }),
      awaitRun: vi.fn(() => new Promise(() => {})),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    let callbacks!: { onInput(data: string): Promise<void>; onStop(): Promise<void> };
    const completeSessionTask = vi.fn(async () => {});
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn((input) => {
        callbacks = input;
        return { id: "task-1" };
      }),
      completeSessionTask,
      writeToSessionTask: vi.fn(async (_taskId, data) => callbacks.onInput(data)),
    };
    const backend = new ChildSessionBackend({ host, taskBridge: bridge });
    await backend.spawn(config());

    await expect(
      backend.sendMessage("Explore@default", { text: "next", fromAgent: "coordinator" }),
    ).rejects.toThrow("child archived");
    expect(completeSessionTask).toHaveBeenCalledWith("task-1", {
      status: "failed",
      output: "child archived",
    });
    expect(host.closeRuntime).toHaveBeenCalledWith("child");
  });

  it("does not complete the task from an older run after a follow-up is queued", async () => {
    const first = deferred<{ status: "completed"; output: string }>();
    const second = deferred<{ status: "completed"; output: string }>();
    const secondAdmission = deferred<{ runId: string }>();
    let admitCount = 0;
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => {
        admitCount += 1;
        return admitCount === 1 ? { runId: "run-1" } : secondAdmission.promise;
      }),
      awaitRun: vi.fn((_sessionId, runId) => runId === "run-1" ? first.promise : second.promise),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    let callbacks!: { onInput(data: string): Promise<void>; onStop(): Promise<void> };
    const completeSessionTask = vi.fn(async () => {});
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn((input) => {
        callbacks = input;
        return { id: "task-1" };
      }),
      completeSessionTask,
      writeToSessionTask: vi.fn(async (_taskId, data) => callbacks.onInput(data)),
    };
    const backend = new ChildSessionBackend({ host, taskBridge: bridge });
    await backend.spawn(config());
    const followUp = backend.sendMessage("Explore@default", { text: "next", fromAgent: "coordinator" });

    first.resolve({ status: "completed", output: "old" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completeSessionTask).not.toHaveBeenCalled();
    expect(host.closeRuntime).not.toHaveBeenCalled();

    secondAdmission.resolve({ runId: "run-2" });
    await followUp;
    second.resolve({ status: "completed", output: "latest" });
    await vi.waitFor(() => {
      expect(completeSessionTask).toHaveBeenCalledWith("task-1", {
        status: "completed",
        output: "latest",
      });
      expect(host.closeRuntime).toHaveBeenCalledTimes(1);
    });
  });

  it("closes the runtime after a failed run without archiving the child", async () => {
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => ({ runId: "run-1" })),
      awaitRun: vi.fn(async () => {
        throw new Error("provider failed");
      }),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    const completeSessionTask = vi.fn(async () => {});
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn(() => ({ id: "task-1" })),
      completeSessionTask,
      writeToSessionTask: vi.fn(async () => {}),
    };
    const backend = new ChildSessionBackend({ host, taskBridge: bridge });

    await backend.spawn(config());

    await vi.waitFor(() => {
      expect(completeSessionTask).toHaveBeenCalledWith("task-1", {
        status: "failed",
        output: "provider failed",
      });
      expect(host.closeRuntime).toHaveBeenCalledWith("child");
    });
    expect(host.archive).not.toHaveBeenCalled();
  });

  it("stops a bridged task by interrupting, closing, then archiving its child", async () => {
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => ({ runId: "run-1" })),
      awaitRun: vi.fn(() => new Promise(() => {})),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    let callbacks!: { onInput(data: string): Promise<void>; onStop(): Promise<void> };
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn((input) => {
        callbacks = input;
        return { id: "task-1" };
      }),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async () => {}),
    };
    const backend = new ChildSessionBackend({ host, taskBridge: bridge });
    await backend.spawn(config());

    await callbacks.onStop();

    expect((host.interrupt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (host.closeRuntime as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect((host.closeRuntime as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      (host.archive as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
  });

  it("rolls back child, task, and isolated worktree when registration fails", async () => {
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => ({ runId: "run-1" })),
      awaitRun: vi.fn(async () => ({ status: "completed", output: "" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn(() => ({ id: "task-1" })),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async () => {}),
    };
    const worktreeManager = {
      isGitRepo: vi.fn(async () => true),
      create: vi.fn(async () => ({
        slug: "default-explore",
        path: "/worktree",
        branch: "worktree-default-explore",
        created: true,
      })),
      remove: vi.fn(async () => {}),
    } as unknown as WorktreeManager;
    const backend = new ChildSessionBackend({
      host,
      taskBridge: bridge,
      worktreeManager,
      registerTeammate: () => {
        throw new Error("register failed");
      },
    });

    await expect(backend.spawn(config({ isolate: true }))).resolves.toMatchObject({
      success: false,
      error: "register failed",
    });
    expect(host.interrupt).toHaveBeenCalledWith("child");
    expect(host.closeRuntime).toHaveBeenCalledWith("child");
    expect(host.archive).toHaveBeenCalledWith("child");
    expect(bridge.completeSessionTask).toHaveBeenCalledWith("task-1", {
      status: "failed",
      output: "register failed",
    });
    expect(worktreeManager.remove).toHaveBeenCalledWith("default-explore", { force: true });
  });

  it("bounds generated worktree slugs for long team and agent names", async () => {
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => ({})),
      awaitRun: vi.fn(async () => ({ status: "completed", output: "" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn(() => ({ id: "task-1" })),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async () => {}),
    };
    const create = vi.fn(async (slug: string) => ({
      slug,
      path: "/worktree",
      branch: `worktree-${slug}`,
      created: true,
    }));
    const worktreeManager = {
      isGitRepo: vi.fn(async () => true),
      create,
    } as unknown as WorktreeManager;
    const backend = new ChildSessionBackend({ host, taskBridge: bridge, worktreeManager });

    await backend.spawn(config({
      isolate: true,
      team: "team".repeat(30),
      name: "agent".repeat(30),
    }));

    expect(create).toHaveBeenCalled();
    expect(create.mock.calls[0]![0].length).toBeLessThanOrEqual(64);
  });

  it("removes a clean isolated worktree when the child is terminated", async () => {
    const host: ChildSessionHost = {
      createChildSession: vi.fn(async () => ({ id: "child" })),
      admitPrompt: vi.fn(async () => ({})),
      awaitRun: vi.fn(async () => ({ status: "completed", output: "" })),
      interrupt: vi.fn(async () => {}),
      closeRuntime: vi.fn(async () => {}),
      archive: vi.fn(async () => {}),
    };
    const bridge: SessionTaskBridge = {
      registerSessionTask: vi.fn(() => ({ id: "task-1" })),
      completeSessionTask: vi.fn(async () => {}),
      writeToSessionTask: vi.fn(async () => {}),
    };
    const worktreeManager = {
      isGitRepo: vi.fn(async () => true),
      create: vi.fn(async () => ({
        slug: "clean-child",
        path: "/worktree",
        branch: "worktree-clean-child",
        created: true,
      })),
      hasChanges: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
    } as unknown as WorktreeManager;
    const backend = new ChildSessionBackend({ host, taskBridge: bridge, worktreeManager });
    await backend.spawn(config({ isolate: true }));

    await backend.terminate("Explore@default");

    expect(worktreeManager.remove).toHaveBeenCalledWith("clean-child");
  });
});
