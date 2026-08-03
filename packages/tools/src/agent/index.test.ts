import { describe, it, expect, beforeEach } from "vitest";
import { agentTool } from "./index.js";
import {
  getBackendRegistry,
  type SwarmBackend,
  type SpawnResult,
  type TeammateSpawnConfig,
} from "@openharness/swarm";

/**
 * 用一个可记录调用的假后端注册进真实 BackendRegistry 单例。
 * Agent 工具现在只按 mode 选明确的 executor；默认注册到 in_process。
 */
function installFakeBackend(
  spawnImpl: (config: TeammateSpawnConfig) => SpawnResult,
  backendName = "in_process",
): {
  calls: TeammateSpawnConfig[];
} {
  const calls: TeammateSpawnConfig[] = [];
  const backend: SwarmBackend = {
    async spawn(config) {
      calls.push(config);
      return spawnImpl(config);
    },
    async sendMessage() {},
    async terminate() {},
  };
  getBackendRegistry().register(backendName, backend);
  return { calls };
}

const ctx = { cwd: "/work" };

describe("agentTool isolate", () => {
  beforeEach(() => {
    // 确保没有 in_process 后端干扰：注册一个会抛的占位，避免被选中。
    // BackendRegistry 没有 unregister，故每次覆盖 subprocess 即可。
  });

  it("declares isolate in inputSchema", () => {
    const props = (agentTool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.isolate).toBeDefined();
    expect((props.isolate as { type: string }).type).toBe("boolean");
  });

  it("defaults to in_process_teammate mode", () => {
    const props = (agentTool.inputSchema as { properties: Record<string, { default?: string; enum?: string[] }> }).properties;
    expect(props.mode?.default).toBe("in_process_teammate");
    expect(props.mode?.enum).toEqual(["in_process_teammate", "remote_agent"]);
  });

  it("rejects local_agent mode instead of treating it as subprocess compatibility", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Explore@default",
      taskId: "task_local",
      backendType: "in_process",
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "explore", mode: "local_agent" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid mode");
    expect(calls).toHaveLength(0);
  });

  it("reports remote_agent as unsupported without spawning", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Explore@default",
      taskId: "task_remote",
      backendType: "in_process",
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "explore", mode: "remote_agent" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not implemented");
    expect(calls).toHaveLength(0);
  });

  it("passes isolate:true through to executor.spawn", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Build@alpha",
      taskId: "task_1",
      backendType: "subprocess",
    }));

    await agentTool.execute(
      { description: "d", prompt: "do work", team: "alpha", isolate: true },
      ctx,
    );

    expect(calls.at(-1)?.isolate).toBe(true);
  });

  it("passes isolate:false when omitted", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Explore@default",
      taskId: "task_2",
      backendType: "subprocess",
    }));

    await agentTool.execute({ description: "d", prompt: "explore" }, ctx);

    expect(calls.at(-1)?.isolate).toBe(false);
  });

  it("uses the current daemon session as the child parent", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Explore@default",
      taskId: "task_parent",
      sessionId: "child",
      backendType: "in_process",
    }));

    await agentTool.execute(
      { description: "d", prompt: "explore" },
      { cwd: "/work", sessionId: "leader-session" },
    );

    expect(calls.at(-1)?.parentSessionId).toBe("leader-session");
  });

  it("includes worktree branch and path in the returned text", async () => {
    installFakeBackend(() => ({
      success: true,
      agentId: "Build@alpha",
      taskId: "task_3",
      backendType: "subprocess",
      worktree: { path: "/wt/alpha-build-xyz", branch: "worktree-alpha-build-xyz" },
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      ctx,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("worktree-alpha-build-xyz");
    expect(text).toContain("/wt/alpha-build-xyz");
  });

  it("passes permissionMode through to executor.spawn", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Build@alpha",
      taskId: "task_pm1",
      backendType: "subprocess",
    }));

    await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "full_auto" },
      ctx,
    );

    expect(calls.at(-1)?.permissionMode).toBe("full_auto");
  });

  it("leaves permissionMode undefined when omitted (backend decides the default)", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Explore@default",
      taskId: "task_pm2",
      backendType: "subprocess",
    }));

    await agentTool.execute({ description: "d", prompt: "explore" }, ctx);

    expect(calls.at(-1)?.permissionMode).toBeUndefined();
  });

  it("rejects an invalid permissionMode with isError instead of spawning", async () => {
    const { calls } = installFakeBackend(() => ({
      success: true,
      agentId: "Build@alpha",
      taskId: "task_pm3",
      backendType: "subprocess",
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "yolo" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("includes notice in the returned text when present", async () => {
    installFakeBackend(() => ({
      success: true,
      agentId: "Build@alpha",
      taskId: "task_4",
      backendType: "subprocess",
      notice: "isolate requested but unavailable; running in shared cwd",
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      ctx,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("isolate requested but unavailable");
  });
});
