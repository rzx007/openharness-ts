import { describe, expect, it, vi } from "vitest";
import { agentTool, sendMessageTool } from "./index.js";
import type { AgentChildAgentHost } from "@openharness/core";

type SpawnInput = Parameters<AgentChildAgentHost["spawnChildAgent"]>[0];
type SpawnResult = Awaited<ReturnType<AgentChildAgentHost["spawnChildAgent"]>>;

function createRuntimeHost(
  spawnImpl: (input: SpawnInput) => Promise<SpawnResult> =
    async () => ({
      id: "invocation-1",
      taskId: "task_1",
      sessionId: "child-1",
      result: Promise.resolve({ status: "completed", output: "done" }),
    }),
) {
  const calls: SpawnInput[] = [];
  const childAgentHost = {
    spawnChildAgent: vi.fn(async (input: SpawnInput) => {
      calls.push(input);
      return await spawnImpl(input);
    }),
    sendChildInput: vi.fn(async () => {}),
    interruptChildAgent: vi.fn(async () => {}),
    awaitChildAgent: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
  };
  const host = {
    emitEvent: vi.fn(),
    requestPermission: vi.fn(async () => ({ status: "approved" as const })),
    childAgentHost,
  };
  return { host, calls };
}

describe("agentTool runtime host", () => {
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

  it("rejects local_agent mode instead of treating it as compatibility", async () => {
    const { host } = createRuntimeHost();

    const result = await agentTool.execute(
      { description: "d", prompt: "explore", mode: "local_agent" },
      { cwd: "/work", runtimeHost: host },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid mode");
    expect(host.childAgentHost.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("reports remote_agent as unsupported without spawning", async () => {
    const { host } = createRuntimeHost();

    const result = await agentTool.execute(
      { description: "d", prompt: "explore", mode: "remote_agent" },
      { cwd: "/work", runtimeHost: host },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not implemented");
    expect(host.childAgentHost.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("requires a runtime host", async () => {
    const result = await agentTool.execute(
      { description: "d", prompt: "explore" },
      { cwd: "/work" },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("No child-agent host");
  });

  it("passes isolate:true through to runtimeHost.childAgentHost.spawnChildAgent", async () => {
    const { host, calls } = createRuntimeHost();

    await agentTool.execute(
      { description: "d", prompt: "do work", team: "alpha", isolate: true },
      { cwd: "/work", runtimeHost: host },
    );

    expect(calls.at(-1)?.isolate).toBe(true);
  });

  it("passes isolate:false when omitted", async () => {
    const { host, calls } = createRuntimeHost();

    await agentTool.execute({ description: "d", prompt: "explore" }, { cwd: "/work", runtimeHost: host });

    expect(calls.at(-1)?.isolate).toBe(false);
  });

  it("passes a generated child session id to the host", async () => {
    const { host, calls } = createRuntimeHost();

    await agentTool.execute(
      { description: "d", prompt: "explore" },
      { cwd: "/work", sessionId: "leader-session", runtimeHost: host },
    );

    expect(calls.at(-1)?.sessionId).toEqual(expect.any(String));
    expect(calls.at(-1)?.cwd).toBe("/work");
  });

  it("includes worktree branch and path in the returned text", async () => {
    const { host } = createRuntimeHost(async () => ({
      id: "invocation-1",
      taskId: "task_3",
      sessionId: "child-1",
      result: Promise.resolve({ status: "completed", output: "done" }),
      worktree: { path: "/wt/alpha-build-xyz", branch: "worktree-alpha-build-xyz" },
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      { cwd: "/work", runtimeHost: host },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("worktree-alpha-build-xyz");
    expect(text).toContain("/wt/alpha-build-xyz");
  });

  it("passes permissionMode through to runtimeHost.childAgentHost.spawnChildAgent", async () => {
    const { host, calls } = createRuntimeHost();

    await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "full_auto" },
      { cwd: "/work", runtimeHost: host },
    );

    expect(calls.at(-1)?.permissionMode).toBe("full_auto");
  });

  it("leaves permissionMode undefined when omitted", async () => {
    const { host, calls } = createRuntimeHost();

    await agentTool.execute({ description: "d", prompt: "explore" }, { cwd: "/work", runtimeHost: host });

    expect(calls.at(-1)?.permissionMode).toBeUndefined();
  });

  it("rejects an invalid permissionMode with isError instead of spawning", async () => {
    const { host } = createRuntimeHost();

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "yolo" },
      { cwd: "/work", runtimeHost: host },
    );

    expect(result.isError).toBe(true);
    expect(host.childAgentHost.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("includes notice in the returned text when present", async () => {
    const { host } = createRuntimeHost(async () => ({
      id: "invocation-1",
      taskId: "task_4",
      result: Promise.resolve({ status: "completed", output: "done" }),
      notice: "isolate requested but unavailable; running in shared cwd",
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      { cwd: "/work", runtimeHost: host },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("isolate requested but unavailable");
  });

  it("sends follow-up input through runtimeHost when task came from Agent", async () => {
    const { host } = createRuntimeHost(async () => ({
      id: "invocation-follow-up",
      taskId: "task_follow_up",
      result: Promise.resolve({ status: "completed", output: "done" }),
    }));
    await agentTool.execute(
      { description: "d", prompt: "do work" },
      { cwd: "/work", runtimeHost: host },
    );

    const result = await sendMessageTool.execute(
      { taskId: "task_follow_up", message: "continue" },
      { cwd: "/work", runtimeHost: host },
    );

    expect(result.isError).toBeUndefined();
    expect(host.childAgentHost.sendChildInput).toHaveBeenCalledWith("task_follow_up", { content: "continue" });
  });
});
