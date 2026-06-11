import { describe, it, expect, vi } from "vitest";
import { SubprocessBackend, type TaskRunner } from "./subprocess.js";
import type { TeammateSpawnConfig } from "./index.js";
import type { WorktreeManager } from "./worktree.js";

/** 最小 mock：仅实现 SubprocessBackend 用到的 WorktreeManager 方法。 */
function mockWorktreeManager(over: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    create: vi.fn().mockResolvedValue({
      slug: "s",
      path: "/wt/path",
      branch: "worktree-s",
      created: true,
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as WorktreeManager;
}

function makeConfig(overrides: Partial<TeammateSpawnConfig> = {}): TeammateSpawnConfig {
  return {
    name: "Explore",
    team: "default",
    prompt: "go investigate",
    cwd: "/work",
    parentSessionId: "main",
    ...overrides,
  };
}

describe("SubprocessBackend", () => {
  it("spawn builds argv via buildCommand and creates a shell task", async () => {
    const createShellTask = vi.fn().mockResolvedValue({ id: "task_42" });
    const stopTask = vi.fn().mockResolvedValue(undefined);
    const runner: TaskRunner = { createShellTask, stopTask };

    const buildCommand = vi.fn(() => ({
      argv: ["node", "cli.js", "--print", "go investigate"],
      env: { FOO: "bar" },
    }));

    const backend = new SubprocessBackend({ taskRunner: runner, buildCommand });
    const config = makeConfig();
    const result = await backend.spawn(config);

    expect(buildCommand).toHaveBeenCalledWith(config);
    expect(createShellTask).toHaveBeenCalledWith({
      argv: ["node", "cli.js", "--print", "go investigate"],
      description: "Explore@default",
      cwd: "/work",
      env: { FOO: "bar" },
    });
    expect(result).toEqual({
      success: true,
      agentId: "Explore@default",
      taskId: "task_42",
      backendType: "subprocess",
    });
  });

  it("terminate stops the mapped task", async () => {
    const createShellTask = vi.fn().mockResolvedValue({ id: "task_7" });
    const stopTask = vi.fn().mockResolvedValue(undefined);
    const runner: TaskRunner = { createShellTask, stopTask };

    const backend = new SubprocessBackend({
      taskRunner: runner,
      buildCommand: () => ({ argv: ["node"] }),
    });

    await backend.spawn(makeConfig({ name: "Plan", team: "alpha" }));
    await backend.terminate("Plan@alpha");

    expect(stopTask).toHaveBeenCalledWith("task_7");
    // mapping cleared after terminate
    await expect(backend.terminate("Plan@alpha")).rejects.toThrow("No active subprocess");
  });

  it("spawn returns success:false with error when createShellTask throws", async () => {
    const createShellTask = vi.fn().mockRejectedValue(new Error("boom"));
    const stopTask = vi.fn();
    const runner: TaskRunner = { createShellTask, stopTask };

    const backend = new SubprocessBackend({
      taskRunner: runner,
      buildCommand: () => ({ argv: ["node"] }),
    });

    const result = await backend.spawn(makeConfig({ name: "Verify", team: "qa" }));
    expect(result).toEqual({
      success: false,
      agentId: "Verify@qa",
      taskId: "",
      backendType: "subprocess",
      error: "boom",
    });
  });

  it("sendMessage throws (one-shot, multi-turn unsupported)", async () => {
    const backend = new SubprocessBackend({
      taskRunner: { createShellTask: vi.fn(), stopTask: vi.fn() },
      buildCommand: () => ({ argv: ["node"] }),
    });
    await expect(
      backend.sendMessage("Explore@default", { text: "hi", fromAgent: "coordinator" }),
    ).rejects.toThrow("one-shot");
  });

  describe("registerTeammate hook", () => {
    it("spawn invokes registerTeammate with the effective config and spawn result", async () => {
      const runner: TaskRunner = {
        createShellTask: vi.fn().mockResolvedValue({ id: "task_9" }),
        stopTask: vi.fn(),
      };
      const registerTeammate = vi.fn();
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        registerTeammate,
      });
      const result = await backend.spawn(makeConfig({ name: "Explore", team: "alpha" }));

      expect(result.success).toBe(true);
      expect(registerTeammate).toHaveBeenCalledTimes(1);
      const [cfg, res] = registerTeammate.mock.calls[0]!;
      expect(cfg.name).toBe("Explore");
      expect(res.agentId).toBe("Explore@alpha");
      expect(res.taskId).toBe("task_9");
    });

    it("registerTeammate failure does not fail the spawn", async () => {
      const runner: TaskRunner = {
        createShellTask: vi.fn().mockResolvedValue({ id: "task_10" }),
        stopTask: vi.fn(),
      };
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        registerTeammate: () => {
          throw new Error("disk full");
        },
      });
      const result = await backend.spawn(makeConfig());
      expect(result.success).toBe(true);
    });

    it("isolated spawn passes the worktree path as the hook config cwd", async () => {
      const runner: TaskRunner = {
        createShellTask: vi.fn().mockResolvedValue({ id: "task_iso" }),
        stopTask: vi.fn(),
      };
      const registerTeammate = vi.fn();
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        worktreeManager: mockWorktreeManager(),
        registerTeammate,
      });
      await backend.spawn(makeConfig({ name: "Build", team: "alpha", isolate: true }));

      const [cfg, res] = registerTeammate.mock.calls[0]!;
      expect(cfg.cwd).toBe("/wt/path");
      expect(res.worktree).toEqual({ path: "/wt/path", branch: "worktree-s" });
    });

    it("failed spawn does not invoke registerTeammate", async () => {
      const runner: TaskRunner = {
        createShellTask: vi.fn().mockRejectedValue(new Error("boom")),
        stopTask: vi.fn(),
      };
      const registerTeammate = vi.fn();
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        registerTeammate,
      });
      const result = await backend.spawn(makeConfig());
      expect(result.success).toBe(false);
      expect(registerTeammate).not.toHaveBeenCalled();
    });
  });

  describe("isolate", () => {
    it("isolate=true creates a worktree and uses its path as cwd", async () => {
      const createShellTask = vi.fn().mockResolvedValue({ id: "task_iso" });
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const runner: TaskRunner = { createShellTask, stopTask };
      const buildCommand = vi.fn((c: TeammateSpawnConfig) => ({ argv: ["node", c.cwd] }));
      const wt = mockWorktreeManager();

      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand,
        worktreeManager: wt,
      });
      const result = await backend.spawn(makeConfig({ name: "Build", team: "alpha", isolate: true }));

      // buildCommand 与 createShellTask 都收到 worktree path 当 cwd
      expect(buildCommand.mock.calls[0]?.[0].cwd).toBe("/wt/path");
      expect(createShellTask).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/wt/path", argv: ["node", "/wt/path"] }),
      );
      expect(wt.create).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.worktree).toEqual({ path: "/wt/path", branch: "worktree-s" });
    });

    it("terminate removes the worktree (non-force)", async () => {
      const runner: TaskRunner = {
        createShellTask: vi.fn().mockResolvedValue({ id: "task_iso" }),
        stopTask: vi.fn().mockResolvedValue(undefined),
      };
      const wt = mockWorktreeManager();
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        worktreeManager: wt,
      });
      await backend.spawn(makeConfig({ name: "Build", team: "alpha", isolate: true }));
      await backend.terminate("Build@alpha");

      expect(wt.remove).toHaveBeenCalledTimes(1);
      // 非 force：无第二参数或不带 force
      const removeArgs = (wt.remove as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(removeArgs?.[1]).toBeUndefined();
    });

    it("terminate swallows remove failure (dirty worktree kept)", async () => {
      const runner: TaskRunner = {
        createShellTask: vi.fn().mockResolvedValue({ id: "task_iso" }),
        stopTask: vi.fn().mockResolvedValue(undefined),
      };
      const wt = mockWorktreeManager({
        remove: vi.fn().mockRejectedValue(new Error("has changes")),
      });
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        worktreeManager: wt,
      });
      await backend.spawn(makeConfig({ name: "Build", team: "alpha", isolate: true }));
      await expect(backend.terminate("Build@alpha")).resolves.toBeUndefined();
      expect(wt.remove).toHaveBeenCalledTimes(1);
    });

    it("isolate=true: createShellTask throws after worktree created → removes worktree (force) and returns success:false", async () => {
      const createShellTask = vi.fn().mockRejectedValue(new Error("spawn boom"));
      const runner: TaskRunner = { createShellTask, stopTask: vi.fn() };
      const wt = mockWorktreeManager();
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        worktreeManager: wt,
      });

      const result = await backend.spawn(makeConfig({ name: "Build", team: "alpha", isolate: true }));

      // worktree 已建，但 createShellTask 抛错 → 必须 force 清理这个孤儿 worktree。
      expect(wt.create).toHaveBeenCalledTimes(1);
      expect(wt.remove).toHaveBeenCalledTimes(1);
      const removeArgs = (wt.remove as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(removeArgs?.[1]).toEqual({ force: true });
      expect(result).toEqual({
        success: false,
        agentId: "Build@alpha",
        taskId: "",
        backendType: "subprocess",
        error: "spawn boom",
      });
    });

    it("isolate=true: cleanup remove failure is swallowed, still returns the original error", async () => {
      const createShellTask = vi.fn().mockRejectedValue(new Error("spawn boom"));
      const runner: TaskRunner = { createShellTask, stopTask: vi.fn() };
      const wt = mockWorktreeManager({
        remove: vi.fn().mockRejectedValue(new Error("cleanup failed")),
      });
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        worktreeManager: wt,
      });

      const result = await backend.spawn(makeConfig({ name: "Build", team: "alpha", isolate: true }));
      // 清理失败不应盖住原始 spawn 错误。
      expect(result.success).toBe(false);
      expect(result.error).toBe("spawn boom");
      expect(wt.remove).toHaveBeenCalledTimes(1);
    });

    it("isolate=true without worktreeManager is a no-op with notice (uses original cwd)", async () => {
      const createShellTask = vi.fn().mockResolvedValue({ id: "task_x" });
      const runner: TaskRunner = { createShellTask, stopTask: vi.fn() };
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: (c) => ({ argv: ["node", c.cwd] }),
      });
      const result = await backend.spawn(makeConfig({ isolate: true, cwd: "/work" }));

      expect(createShellTask).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/work" }),
      );
      expect(result.success).toBe(true);
      expect(result.worktree).toBeUndefined();
      expect(result.notice).toMatch(/isolate/);
    });

    it("isolate=true but not a git repo degrades to original cwd", async () => {
      const createShellTask = vi.fn().mockResolvedValue({ id: "task_x" });
      const runner: TaskRunner = { createShellTask, stopTask: vi.fn() };
      const wt = mockWorktreeManager({ isGitRepo: vi.fn().mockResolvedValue(false) });
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: (c) => ({ argv: ["node", c.cwd] }),
        worktreeManager: wt,
      });
      const result = await backend.spawn(makeConfig({ isolate: true, cwd: "/work" }));

      expect(wt.create).not.toHaveBeenCalled();
      expect(createShellTask).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work" }));
      expect(result.worktree).toBeUndefined();
      expect(result.notice).toMatch(/isolate/);
    });

    it("isolate=false never touches the worktree manager", async () => {
      const createShellTask = vi.fn().mockResolvedValue({ id: "task_x" });
      const runner: TaskRunner = { createShellTask, stopTask: vi.fn() };
      const wt = mockWorktreeManager();
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        worktreeManager: wt,
      });
      const result = await backend.spawn(makeConfig({ cwd: "/work" }));
      await backend.terminate("Explore@default");

      expect(wt.isGitRepo).not.toHaveBeenCalled();
      expect(wt.create).not.toHaveBeenCalled();
      expect(wt.remove).not.toHaveBeenCalled();
      expect(createShellTask).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work" }));
      expect(result.worktree).toBeUndefined();
    });
  });
});
