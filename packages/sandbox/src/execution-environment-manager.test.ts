import { describe, expect, it, vi } from "vitest";

import type { ExecutionEnvironmentHandle } from "@openharness/environment";
import { ExecutionEnvironmentManager } from "./execution-environment-manager.js";

describe("ExecutionEnvironmentManager", () => {
  it("coalesces concurrent acquires and releases only after the final lease", async () => {
    const handle = fakeHandle();
    const create = vi.fn(async () => handle);
    const manager = new ExecutionEnvironmentManager();

    const [agent, terminal] = await Promise.all([
      manager.acquire(request("owner-1", "hash-1", "agent", "s1", create)),
      manager.acquire(request("owner-1", "hash-1", "terminal", "t1", create)),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(agent.environmentId).toBe(terminal.environmentId);
    expect(manager.inspect("owner-1")).toMatchObject({ state: "ready", leaseCount: 2 });

    await agent.release();
    await agent.release();
    expect(handle.release).not.toHaveBeenCalled();
    await terminal.release();
    expect(handle.release).toHaveBeenCalledOnce();
    expect(manager.inspect("owner-1")).toBeUndefined();
  });

  it("rejects a different config while an owner has active leases", async () => {
    const manager = new ExecutionEnvironmentManager();
    const lease = await manager.acquire(request(
      "owner-1",
      "hash-1",
      "agent",
      "s1",
      async () => fakeHandle(),
    ));

    await expect(manager.acquire(request(
      "owner-1",
      "hash-2",
      "terminal",
      "t1",
      async () => fakeHandle(),
    ))).rejects.toMatchObject({ code: "environment_config_in_use" });

    await lease.release();
  });

  it("does not start a replacement until the previous environment stops", async () => {
    let finishRelease!: () => void;
    const first = fakeHandle(new Promise<void>((resolve) => { finishRelease = resolve; }));
    const second = fakeHandle();
    const manager = new ExecutionEnvironmentManager();
    const lease = await manager.acquire(request("owner-1", "hash-1", "agent", "s1", async () => first));
    const releasing = lease.release();
    const createSecond = vi.fn(async () => second);
    const acquiring = manager.acquire(request("owner-1", "hash-2", "agent", "s2", createSecond));

    await Promise.resolve();
    expect(createSecond).not.toHaveBeenCalled();
    finishRelease();
    await releasing;
    const replacement = await acquiring;
    expect(createSecond).toHaveBeenCalledOnce();
    await replacement.release();
  });
});

function request(
  ownerId: string,
  configHash: string,
  kind: "agent" | "terminal" | "background",
  id: string,
  create: () => Promise<ExecutionEnvironmentHandle>,
) {
  return { ownerId, configHash, consumer: { kind, id }, create };
}

function fakeHandle(releaseWait?: Promise<void>): ExecutionEnvironmentHandle {
  return {
    info: {
      kind: "docker",
      hostOs: "Windows",
      executionOs: "Linux",
      shell: "/bin/sh",
      shellDialect: "posix",
      pathStyle: "posix",
      cwd: "/workspace",
      homeDir: "/root",
      tempDir: "/tmp",
      mounts: [],
      networkMode: "none",
      limitations: [],
    },
    workspace: { kind: "docker", hostRoot: "D:\\repo", executionRoot: "/workspace" },
    process: {} as never,
    terminal: {} as never,
    files: {} as never,
    paths: {} as never,
    release: vi.fn(async () => { await releaseWait; }),
  };
}
