import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildAgentExecutionRegistry,
  DetachedProcessSupervisor,
  getChildAgentExecutionRegistry,
  getDetachedProcessSupervisor,
  resetExecutionRuntimes,
} from "../index.js";

afterEach(() => {
  resetExecutionRuntimes();
});

describe("detached execution runtime split", () => {
  it("keeps process spawning out of the child Agent registry", () => {
    const processes = new DetachedProcessSupervisor();
    const childAgents = new ChildAgentExecutionRegistry();

    expect(typeof processes.startShellExecution).toBe("function");
    expect("registerChildExecution" in processes).toBe(false);
    expect(typeof childAgents.registerChildExecution).toBe("function");
    expect("startShellExecution" in childAgents).toBe(false);

    processes.close();
    childAgents.close();
  });

  it("scopes the two runtime backends independently by cwd and session", () => {
    const scope = { cwd: process.cwd(), sessionId: "split-session" };
    const processes = getDetachedProcessSupervisor(scope);
    const childAgents = getChildAgentExecutionRegistry(scope);

    expect(getDetachedProcessSupervisor(scope)).toBe(processes);
    expect(getChildAgentExecutionRegistry(scope)).toBe(childAgents);
    expect(processes).not.toBe(childAgents);

    const onInput = vi.fn(async () => {});
    const child = childAgents.registerChildExecution({
      id: "child-1",
      description: "child Agent",
      cwd: scope.cwd,
      sessionId: scope.sessionId,
      childSessionId: "child-session",
      prompt: "work",
      onInput,
      onStop: vi.fn(async () => {}),
    });

    expect(childAgents.getExecution(child.id)).toEqual(child);
    expect(processes.getExecution(child.id)).toBeUndefined();
  });
});
