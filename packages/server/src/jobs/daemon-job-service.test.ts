import type { SessionExecutionRecord } from "@openharness/protocol";
import type { TerminalSessionInfo } from "@openharness/terminal";
import { describe, expect, it, vi } from "vitest";

import { DaemonJobService } from "./daemon-job-service.js";

const terminal: TerminalSessionInfo = {
  id: "terminal-1",
  name: "dev server",
  projectId: "project-1",
  runtime: "local",
  source: "agent",
  sessionId: "session-1",
  status: "running",
  cwd: "/repo",
  shell: "/bin/sh",
  cols: 100,
  rows: 30,
  createdAt: "2026-08-17T00:00:00.000Z",
};

const task: SessionExecutionRecord = {
  id: "task-1",
  sessionId: "session-1",
  type: "agent",
  status: "running",
  description: "review",
  cwd: "/repo",
  metadata: {
    executionBackend: "child_agent",
    runtimeExecutionId: "manager-1",
  },
  createdAt: 10,
  startedAt: 11,
  updatedAt: 12,
};

describe("DaemonJobService", () => {
  it("projects owned terminals and durable tasks into one list", async () => {
    const { service } = createService();
    const jobs = await service.list({ sessionId: "session-1" });

    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "terminal-1", kind: "terminal", ownerSession: "session-1" }),
      expect.objectContaining({ id: "task-1", kind: "agent", ownerSession: "session-1" }),
    ]));
  });

  it("forwards terminal output cursors through the common read protocol", async () => {
    const { service, terminals } = createService();
    const result = await service.read({ sessionId: "session-1", jobId: "terminal-1", after: 4, maxChars: 20 });

    expect(terminals.readRequest).toHaveBeenCalledWith({ terminalId: "terminal-1", after: 4, maxChars: 20 });
    expect(result).toMatchObject({ text: "ready", cursor: 5, snapshot: { kind: "terminal" } });
  });

  it("uses the terminal provider settlement wait", async () => {
    const { service, terminals } = createService();
    terminals.wait.mockResolvedValue({
      terminalId: terminal.id,
      data: "done",
      sequence: 6,
      truncated: false,
      terminal: { ...terminal, status: "completed", exitedAt: "2026-08-17T00:00:01.000Z", exitCode: 0 },
      timedOut: false,
    });

    const result = await service.wait({ sessionId: "session-1", jobId: terminal.id, timeoutMs: 500, after: 5 });

    expect(terminals.wait).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: terminal.id,
      timeoutMs: 500,
      after: 5,
    }));
    expect(result).toMatchObject({ timedOut: false, text: "done", snapshot: { status: "completed" } });
  });

  it("does not let an Agent address another session through its host", async () => {
    const { service } = createService();
    const host = service.createAgentHost({ id: "session-1" } as any);
    await expect(host.list({ sessionId: "session-2" })).rejects.toThrow("owner session mismatch");
  });

  it.each([
    { type: "shell", status: "running" },
    { type: "agent", status: "stopped" },
    { type: "agent", status: "interrupted" },
  ] as const)("rejects input when a $status $type job does not advertise send", async (change) => {
    const projected = { ...task, ...change };
    const { service, manager } = createService(projected);

    await expect(service.send({
      sessionId: "session-1",
      jobId: projected.id,
      data: "continue",
    })).rejects.toThrow("does not accept input");
    expect(manager.writeInput).not.toHaveBeenCalled();
  });

  it.each(["pending", "running", "completed", "failed"] as const)(
    "sends input to a %s Agent job so its session can continue",
    async (status) => {
      const projected = { ...task, status };
      const { service, manager } = createService(projected);

      await service.send({
        sessionId: "session-1",
        jobId: projected.id,
        data: "continue",
      });

      expect(manager.writeInput).toHaveBeenCalledWith("manager-1", "continue");
      await expect(service.list({ sessionId: "session-1" })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: projected.id, capabilities: expect.objectContaining({ send: true }) }),
        ]),
      );
    },
  );

  it("cancels a reserved shell before a runtime process exists", async () => {
    const pending = {
      ...task,
      type: "shell",
      status: "pending" as const,
      metadata: { admissionPhase: "dispatching" },
    };
    const { service, store, manager } = createService(pending);

    await expect(service.cancel({
      sessionId: "session-1",
      jobId: pending.id,
      reason: "no longer needed",
    })).resolves.toMatchObject({
      id: pending.id,
      status: "killed",
      metadata: { admissionPhase: "cancelled_before_start" },
    });
    expect(manager.stopExecution).not.toHaveBeenCalled();
    expect(store.updateSessionTask).toHaveBeenCalledWith(pending.id, {
      status: "stopped",
      metadata: { admissionPhase: "cancelled_before_start" },
    });
  });

  it("lets an inherited root host operate on a descendant's own jobs", async () => {
    const childTask = { ...task, sessionId: "child-1" };
    const { service, store } = createService(childTask);
    store.getSession.mockImplementation((id: string) => {
      if (id === "session-1") return { id, cwd: "/repo" } as any;
      if (id === "child-1") return { id, parentId: "session-1", cwd: "/repo/worktree" } as any;
      return undefined;
    });
    const host = service.createAgentHost({ id: "session-1" } as any);

    await expect(host.list({ sessionId: "child-1" })).resolves.toContainEqual(
      expect.objectContaining({ id: childTask.id, ownerSession: "child-1" }),
    );
  });

  it("cancels a Workflow by stopping child-agent workers, not only detached processes", async () => {
    const {
      createWorkflowPlan,
      createWorkflowRunSnapshot,
    } = await import("@openharness/coordinator");
    const worker: SessionExecutionRecord = {
      ...task,
      id: "worker-child-1",
      metadata: {
        origin: "child_session",
        executionBackend: "child_agent",
        runtimeExecutionId: "worker-child-1",
      },
    };
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    const workflow = createWorkflowRunSnapshot({
      runId: "wf-cancel-child",
      ownerSession: "session-1",
      status: "running",
      summary: "review running",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(["review"]),
      runningTasks: new Map([[
        "review",
        {
          taskId: "review",
          attempt: 1,
          dependencies: [],
          startedAt: 10,
          summary: "Waiting for worker",
          metadata: { workerTaskId: "worker-child-1" },
        },
      ]]),
      createdAt: 1,
    });
    const processes = {
      readOutput: vi.fn(() => ""),
      writeInput: vi.fn(async () => undefined),
      stopExecution: vi.fn(async () => {
        throw new Error("Execution not found: worker-child-1");
      }),
    };
    const childAgents = {
      readOutput: vi.fn(() => ""),
      writeInput: vi.fn(async () => undefined),
      stopExecution: vi.fn(async () => worker),
    };
    let current = workflow;
    const workflows = {
      repositoryKey: "test-workflows",
      list: () => [current],
      load: (runId: string) => runId === current.runId ? current : undefined,
      claim: vi.fn(),
      finish: vi.fn(),
      save: vi.fn((snapshot: typeof workflow) => {
        current = snapshot;
        return snapshot;
      }),
      appendEvent: vi.fn(),
      loadEvents: vi.fn(() => []),
      listSummaries: vi.fn(() => []),
      latest: vi.fn(() => current),
      waitForChange: vi.fn(async () => current),
    };
    const { service } = createService(worker, { processes, childAgents, workflows });

    await expect(service.cancel({
      sessionId: "session-1",
      jobId: "workflow:wf-cancel-child",
      reason: "user cancelled",
    })).resolves.toMatchObject({
      id: "workflow:wf-cancel-child",
      kind: "workflow",
      status: "killed",
    });

    expect(childAgents.stopExecution).toHaveBeenCalledWith("worker-child-1");
    expect(processes.stopExecution).not.toHaveBeenCalled();
  });
});

function createService(
  projectedTask: SessionExecutionRecord = task,
  overrides: {
    processes?: {
      readOutput: ReturnType<typeof vi.fn>;
      writeInput: ReturnType<typeof vi.fn>;
      stopExecution: ReturnType<typeof vi.fn>;
    };
    childAgents?: {
      readOutput: ReturnType<typeof vi.fn>;
      writeInput: ReturnType<typeof vi.fn>;
      stopExecution: ReturnType<typeof vi.fn>;
    };
    workflows?: Record<string, unknown>;
  } = {},
) {
  const store = {
    getSession: vi.fn((id: string) => id === "session-1" ? { id, cwd: "/repo" } : undefined),
    listSessionTasks: vi.fn(() => [projectedTask]),
    getSessionTask: vi.fn((id: string) => id === projectedTask.id ? projectedTask : undefined),
    updateSessionTask: vi.fn((_id: string, input: Record<string, unknown>) => ({
      ...projectedTask,
      ...input,
    })),
  };
  const terminals = {
    list: vi.fn(async () => [terminal]),
    get: vi.fn(async () => terminal),
    readRequest: vi.fn(async () => ({ terminalId: terminal.id, data: "ready", sequence: 5, truncated: false })),
    write: vi.fn(),
    close: vi.fn(),
    wait: vi.fn(),
  };
  const manager = overrides.processes ?? {
    readOutput: vi.fn(() => "task output"),
    writeInput: vi.fn(async () => undefined),
    stopExecution: vi.fn(async () => projectedTask),
  };
  const childAgents = overrides.childAgents ?? manager;
  return {
    service: new DaemonJobService(
      store as any,
      terminals as any,
      () => manager,
      () => childAgents,
      (overrides.workflows ?? { list: () => [], load: () => undefined }) as any,
    ),
    store,
    terminals,
    manager,
    childAgents,
  };
}
