import { describe, expect, it, vi } from "vitest";
import { agentTool, sendMessageTool } from "./index.js";
import type { AgentChildController, AgentExecutionContext } from "@openharness/core";

type SpawnInput = Parameters<AgentChildController["spawnChildAgent"]>[0];
type SpawnResult = Awaited<ReturnType<AgentChildController["spawnChildAgent"]>>;

function createAgentContext(
  spawnImpl: (input: SpawnInput) => Promise<SpawnResult> =
    async () => ({
      id: "task_1",
      sessionId: "child-1",
      result: Promise.resolve({ status: "completed", output: "done" }),
    }),
) {
  const calls: SpawnInput[] = [];
  const children: AgentChildController = {
    spawnChildAgent: vi.fn(async (input: SpawnInput) => {
      calls.push(input);
      return await spawnImpl(input);
    }),
    sendChildInput: vi.fn(async () => {}),
    interruptChildAgent: vi.fn(async () => {}),
    awaitChildAgent: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
  };
  const agent: AgentExecutionContext = {
    scope: {
      agentId: "leader",
      sessionId: "leader-session",
      inputId: "input-1",
      runId: "run-1",
      traceId: "trace-1",
      cwd: "/work",
      signal: new AbortController().signal,
    },
    effects: { requestPermission: vi.fn(async () => ({ status: "approved" as const })) },
    children,
    emit: vi.fn(),
    takeSteeredInputs: () => [],
  };
  return { agent, children, calls };
}

describe("agentTool framework child controller", () => {
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
    const { agent, children } = createAgentContext();

    const result = await agentTool.execute(
      { description: "d", prompt: "explore", mode: "local_agent" },
      { cwd: "/work", agent },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid mode");
    expect(children.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("reports remote_agent as unsupported without spawning", async () => {
    const { agent, children } = createAgentContext();

    const result = await agentTool.execute(
      { description: "d", prompt: "explore", mode: "remote_agent" },
      { cwd: "/work", agent },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not implemented");
    expect(children.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("requires a runtime host", async () => {
    const result = await agentTool.execute(
      { description: "d", prompt: "explore" },
      { cwd: "/work" },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("No framework child manager");
  });

  it("passes isolate:true through to the framework child controller", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute(
      { description: "d", prompt: "do work", team: "alpha", isolate: true },
      { cwd: "/work", agent },
    );

    expect(calls.at(-1)?.isolate).toBe(true);
  });

  it("passes isolate:false when omitted", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute({ description: "d", prompt: "explore" }, { cwd: "/work", agent });

    expect(calls.at(-1)?.isolate).toBe(false);
  });

  it("passes a generated child session id to the host", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute(
      { description: "d", prompt: "explore" },
      { cwd: "/work", sessionId: "leader-session", agent },
    );

    expect(calls.at(-1)?.sessionId).toEqual(expect.any(String));
    expect(calls.at(-1)?.cwd).toBe("/work");
  });

  it("includes worktree branch and path in the returned text", async () => {
    const { agent } = createAgentContext(async () => ({
      id: "task_3",
      sessionId: "child-1",
      result: Promise.resolve({ status: "completed", output: "done" }),
      worktree: { path: "/wt/alpha-build-xyz", branch: "worktree-alpha-build-xyz" },
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      { cwd: "/work", agent },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("worktree-alpha-build-xyz");
    expect(text).toContain("/wt/alpha-build-xyz");
  });

  it("passes permissionMode through to the framework child controller", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "full_auto" },
      { cwd: "/work", agent },
    );

    expect(calls.at(-1)?.permissionMode).toBe("full_auto");
  });

  it("leaves permissionMode undefined when omitted", async () => {
    const { agent, calls } = createAgentContext();

    await agentTool.execute({ description: "d", prompt: "explore" }, { cwd: "/work", agent });

    expect(calls.at(-1)?.permissionMode).toBeUndefined();
  });

  it("rejects an invalid permissionMode with isError instead of spawning", async () => {
    const { agent, children } = createAgentContext();

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", permissionMode: "yolo" },
      { cwd: "/work", agent },
    );

    expect(result.isError).toBe(true);
    expect(children.spawnChildAgent).not.toHaveBeenCalled();
  });

  it("includes notice in the returned text when present", async () => {
    const { agent } = createAgentContext(async () => ({
      id: "task_4",
      sessionId: "child-4",
      result: Promise.resolve({ status: "completed", output: "done" }),
      notice: "isolate requested but unavailable; running in shared cwd",
    }));

    const result = await agentTool.execute(
      { description: "d", prompt: "do work", isolate: true },
      { cwd: "/work", agent },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("isolate requested but unavailable");
  });

  it("sends follow-up input through the framework controller", async () => {
    const { agent, children } = createAgentContext(async () => ({
      id: "task_follow_up",
      sessionId: "child-follow-up",
      result: Promise.resolve({ status: "completed", output: "done" }),
    }));
    await agentTool.execute(
      { description: "d", prompt: "do work" },
      { cwd: "/work", agent },
    );

    const result = await sendMessageTool.execute(
      { taskId: "task_follow_up", message: "continue" },
      { cwd: "/work", agent },
    );

    expect(result.isError).toBeUndefined();
    expect(children.sendChildInput).toHaveBeenCalledWith("task_follow_up", { content: "continue" });
  });
});
