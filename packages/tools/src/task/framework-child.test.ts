import type { AgentChildController, AgentExecutionContext } from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { taskStopTool, taskWaitTool } from "./index.js";

const CWD = process.cwd();

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((content) => content.text ?? "").join("");
}

function createFrameworkAgent(
  taskId: string,
  result: Promise<{ status: "completed" | "failed" | "interrupted" | "stopped"; output: string; error?: string }>,
): { agent: AgentExecutionContext; children: AgentChildController } {
  const children: AgentChildController = {
    hasChildAgent: (id) => id === taskId,
    spawnChildAgent: vi.fn(async () => { throw new Error("not used"); }),
    sendChildInput: vi.fn(async () => { throw new Error("not used"); }),
    interruptChildAgent: vi.fn(async () => {}),
    awaitChildAgent: vi.fn(async () => await result),
  };
  return {
    children,
    agent: {
      scope: {
        agentId: "sdk-agent",
        sessionId: "sdk-session",
        inputId: "sdk-input",
        runId: "sdk-run",
        traceId: "sdk-trace",
        cwd: CWD,
        signal: new AbortController().signal,
      },
      effects: { requestPermission: async () => ({ status: "approved" }) },
      children,
      emit: async () => {},
      takeSteeredInputs: async () => [],
      closeSteering: () => {},
    },
  };
}

describe("framework child task tools", () => {
  it("awaits an Agent-created child without a TaskManager projection", async () => {
    const taskId = "child_sdk_completed";
    const { agent, children } = createFrameworkAgent(
      taskId,
      Promise.resolve({ status: "completed", output: "framework-result" }),
    );

    const result = await taskWaitTool.execute({ taskIds: [taskId] }, { cwd: CWD, agent });

    expect(textOf(result)).toContain("framework-result");
    expect(children.awaitChildAgent).toHaveBeenCalledWith(taskId);
    expect(result.isError).toBeFalsy();
  });

  it("returns a heartbeat without interrupting the child", async () => {
    const taskId = "child_sdk_heartbeat";
    const { agent, children } = createFrameworkAgent(taskId, new Promise(() => {}));

    const result = await taskWaitTool.execute(
      { taskIds: [taskId], timeoutSeconds: 5, heartbeatSeconds: 0.01 },
      { cwd: CWD, agent },
    );

    expect(textOf(result)).toContain("still running after 0.01s");
    expect(children.interruptChildAgent).not.toHaveBeenCalled();
  });

  it("interrupts the child after a hard TaskWait timeout", async () => {
    const taskId = "child_sdk_timeout";
    const { agent, children } = createFrameworkAgent(taskId, new Promise(() => {}));

    const result = await taskWaitTool.execute(
      { taskIds: [taskId], timeoutSeconds: 0.01 },
      { cwd: CWD, agent },
    );

    expect(textOf(result)).toContain("stop requested");
    expect(children.interruptChildAgent).toHaveBeenCalledWith(taskId, "TaskWait interrupted or timed out");
  });

  it("routes TaskStop to the child controller", async () => {
    const taskId = "child_sdk_stop";
    const { agent, children } = createFrameworkAgent(taskId, new Promise(() => {}));

    const result = await taskStopTool.execute({ taskId }, { cwd: CWD, agent });

    expect(textOf(result)).toContain(`Stopped task ${taskId}`);
    expect(children.interruptChildAgent).toHaveBeenCalledWith(taskId, "TaskStop requested");
    expect(result.isError).toBeFalsy();
  });
});
