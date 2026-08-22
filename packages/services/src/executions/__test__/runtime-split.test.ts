import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildAgentExecutionRegistry,
  closeExecutionRuntimes,
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

  it("removes registered runtimes immediately and waits for process cleanup", async () => {
    const scope = { cwd: process.cwd(), sessionId: "shutdown-session" };
    const processes = getDetachedProcessSupervisor(scope);
    const childAgents = getChildAgentExecutionRegistry(scope);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const closeProcesses = vi.spyOn(processes, "aclose").mockReturnValue(cleanup);
    const closeChildren = vi.spyOn(childAgents, "close");

    let closed = false;
    const closing = closeExecutionRuntimes().then(() => { closed = true; });

    expect(getDetachedProcessSupervisor(scope)).not.toBe(processes);
    expect(getChildAgentExecutionRegistry(scope)).not.toBe(childAgents);
    expect(closeChildren).toHaveBeenCalledOnce();
    expect(closeProcesses).toHaveBeenCalledOnce();
    expect(closed).toBe(false);

    finishCleanup();
    await closing;
    expect(closed).toBe(true);
  });
});
