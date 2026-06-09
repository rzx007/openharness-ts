import { describe, it, expect, vi } from "vitest";
import { SubprocessBackend, type TaskRunner } from "./subprocess.js";
import type { TeammateSpawnConfig } from "./index.js";

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
});
