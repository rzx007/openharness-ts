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


/** 完整 TaskRunner mock(createAgentTask/writeToTask/createShellTask/stopTask)。 */
function makeRunner(over: Record<string, unknown> = {}) {
  return {
    createShellTask: vi.fn().mockResolvedValue({ id: "task_shell" }),
    createAgentTask: vi.fn().mockResolvedValue({ id: "task_42" }),
    writeToTask: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as TaskRunner & {
    createAgentTask: ReturnType<typeof vi.fn>;
    writeToTask: ReturnType<typeof vi.fn>;
    stopTask: ReturnType<typeof vi.fn>;
  };
}

describe("SubprocessBackend", () => {
  it("spawn builds argv via buildCommand and creates an agent task (prompt via stdin)", async () => {
    const runner = makeRunner();
    const buildCommand = vi.fn(() => ({
      argv: ["node", "cli.js", "--task-worker"],
      env: { FOO: "bar" },
    }));

    const backend = new SubprocessBackend({ taskRunner: runner, buildCommand });
    const config = makeConfig();
    const result = await backend.spawn(config);

    expect(buildCommand).toHaveBeenCalledWith(config);
    expect(runner.createAgentTask).toHaveBeenCalledWith({
      prompt: "go investigate",
      argv: ["node", "cli.js", "--task-worker"],
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
    const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_7" }) });

    const backend = new SubprocessBackend({
      taskRunner: runner,
      buildCommand: () => ({ argv: ["node"] }),
    });

    await backend.spawn(makeConfig({ name: "Plan", team: "alpha" }));
    await backend.terminate("Plan@alpha");

    expect(runner.stopTask).toHaveBeenCalledWith("task_7");
    // mapping cleared after terminate
    await expect(backend.terminate("Plan@alpha")).rejects.toThrow("No active subprocess");
  });

  it("spawn returns success:false with error when createShellTask throws", async () => {
    const runner = makeRunner({ createAgentTask: vi.fn().mockRejectedValue(new Error("boom")) });

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

  it("sendMessage writes a JSON line to the task stdin (lazy-restart multi-turn)", async () => {
    const runner = makeRunner();
    const backend = new SubprocessBackend({
      taskRunner: runner,
      buildCommand: () => ({ argv: ["node"] }),
    });
    await backend.spawn(makeConfig());
    await backend.sendMessage("Explore@default", { text: "hi again", fromAgent: "coordinator" });

    expect(runner.writeToTask).toHaveBeenCalledTimes(1);
    const [taskId, line] = runner.writeToTask.mock.calls[0]!;
    expect(taskId).toBe("task_42");
    const payload = JSON.parse(line as string);
    expect(payload.text).toBe("hi again");
    expect(payload.from).toBe("coordinator");
    expect(typeof payload.timestamp).toBe("string");

    await expect(
      backend.sendMessage("Ghost@nowhere", { text: "x", fromAgent: "c" }),
    ).rejects.toThrow("No active subprocess");
  });

  describe("registerTeammate hook", () => {
    it("spawn invokes registerTeammate with the effective config and spawn result", async () => {
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_9" }) });
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

    it("registerTeammate failure causes spawn to fail, cleans agentTasks, and stops the orphan task", async () => {
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_10" }) });
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: () => ({ argv: ["node"] }),
        registerTeammate: () => {
          throw new Error("disk full");
        },
      });
      const result = await backend.spawn(makeConfig());
      expect(result.success).toBe(false);
      expect(result.error).toBe("disk full");
      // agentTasks 必须已清空，不能留孤儿条目
      expect(backend.getTaskId("Explore@default")).toBeUndefined();
      // 孤儿任务必须被 stop
      expect(runner.stopTask).toHaveBeenCalledWith("task_10");
    });

    it("isolated spawn passes the worktree path as the hook config cwd", async () => {
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_iso" }) });
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
      const runner = makeRunner({ createAgentTask: vi.fn().mockRejectedValue(new Error("boom")) });
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
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_iso" }) });
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
      expect(runner.createAgentTask).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/wt/path", argv: ["node", "/wt/path"] }),
      );
      expect(wt.create).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.worktree).toEqual({ path: "/wt/path", branch: "worktree-s" });
    });

    it("terminate removes the worktree (non-force)", async () => {
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_iso" }) });
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
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_iso" }) });
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
      const runner = makeRunner({ createAgentTask: vi.fn().mockRejectedValue(new Error("spawn boom")) });
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
      const runner = makeRunner({ createAgentTask: vi.fn().mockRejectedValue(new Error("spawn boom")) });
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
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_x" }) });
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: (c) => ({ argv: ["node", c.cwd] }),
      });
      const result = await backend.spawn(makeConfig({ isolate: true, cwd: "/work" }));

      expect(runner.createAgentTask).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/work" }),
      );
      expect(result.success).toBe(true);
      expect(result.worktree).toBeUndefined();
      expect(result.notice).toMatch(/isolate/);
    });

    it("isolate=true but not a git repo degrades to original cwd", async () => {
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_x" }) });
      const wt = mockWorktreeManager({ isGitRepo: vi.fn().mockResolvedValue(false) });
      const backend = new SubprocessBackend({
        taskRunner: runner,
        buildCommand: (c) => ({ argv: ["node", c.cwd] }),
        worktreeManager: wt,
      });
      const result = await backend.spawn(makeConfig({ isolate: true, cwd: "/work" }));

      expect(wt.create).not.toHaveBeenCalled();
      expect(runner.createAgentTask).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work" }));
      expect(result.worktree).toBeUndefined();
      expect(result.notice).toMatch(/isolate/);
    });

    it("isolate=false never touches the worktree manager", async () => {
      const runner = makeRunner({ createAgentTask: vi.fn().mockResolvedValue({ id: "task_x" }) });
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
      expect(runner.createAgentTask).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work" }));
      expect(result.worktree).toBeUndefined();
    });
  });
});
