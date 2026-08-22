import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentChildDirectory,
  AgentChildHandle,
  AgentChildResult,
} from "@openharness/core";
import {
  createWorkflowPlan,
  createWorkflowRunSnapshot,
  FileWorkflowRunRepository,
} from "@openharness/coordinator";
import { resetExecutionRuntimes } from "@openharness/services/executions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalAgentJobHost } from "./local-job-host.js";

const createdDirectories: string[] = [];

afterEach(() => {
  for (const cwd of createdDirectories.splice(0)) {
    resetExecutionRuntimes({ cwd, sessionId: "session-1" });
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("LocalAgentJobHost adapter", () => {
  it("lists, sends to, and waits for a framework child", async () => {
    const cwd = temporaryDirectory();
    let state: AgentChildHandle["state"] = "running";
    let settle!: (result: AgentChildResult) => void;
    const result = new Promise<AgentChildResult>((resolve) => { settle = resolve; });
    const send = vi.fn(async () => ({ sessionId: "child-session", inputId: "input-2", runId: "run-2" }));
    const handle: AgentChildHandle = {
      id: "child-1",
      sessionId: "child-session",
      get state() { return state; },
      result,
      send,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const host = new LocalAgentJobHost(cwd, "session-1", directory(handle));

    await expect(host.list({
      sessionId: "session-1",
      kinds: ["agent"],
      statuses: ["running"],
    })).resolves.toEqual([
      expect.objectContaining({ id: "child-1", kind: "agent", status: "running" }),
    ]);

    await host.send({ sessionId: "session-1", jobId: "child-1", data: "continue" });
    expect(send).toHaveBeenCalledWith({ content: "continue" });

    const waiting = host.wait({ sessionId: "session-1", jobId: "child-1", timeoutMs: 1_000 });
    state = "idle";
    settle({ status: "completed", output: "child result" });

    await expect(waiting).resolves.toMatchObject({
      text: "child result",
      timedOut: false,
      snapshot: { id: "child-1", status: "completed" },
    });
  });

  it("rejects a different session owner", async () => {
    const cwd = temporaryDirectory();
    const host = new LocalAgentJobHost(cwd, "session-1", directory());

    await expect(host.list({ sessionId: "session-2" })).rejects.toThrow("owner session mismatch");
  });

  it("reports a failed child as a fact and keeps the parent job host usable", async () => {
    const cwd = temporaryDirectory();
    const failedHandle: AgentChildHandle = {
      id: "child-failed",
      sessionId: "child-failed-session",
      state: "idle",
      result: Promise.resolve({ status: "failed", output: "tests failed", error: "tests failed" }),
      send: vi.fn(async () => ({ sessionId: "child-failed-session", inputId: "i2", runId: "r2" })),
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const host = new LocalAgentJobHost(cwd, "session-1", directory(failedHandle));

    await expect(host.wait({
      sessionId: "session-1",
      jobId: "child-failed",
      timeoutMs: 1_000,
    })).resolves.toMatchObject({
      text: "tests failed",
      timedOut: false,
      snapshot: {
        status: "failed",
        metadata: { failureKind: "failed" },
      },
    });
    await expect(host.list({ sessionId: "session-1" })).resolves.toHaveLength(1);
  });

  it("returns structured Workflow details from JobRead", async () => {
    const cwd = temporaryDirectory();
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    new FileWorkflowRunRepository({ cwd }).save(createWorkflowRunSnapshot({
      runId: "workflow-1",
      ownerSession: "session-1",
      status: "running",
      summary: "review in progress",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(["review"]),
      createdAt: 10,
    }));
    const host = new LocalAgentJobHost(cwd, "session-1", directory());

    await expect(host.read({ sessionId: "session-1", jobId: "workflow-1" }))
      .resolves.toMatchObject({
        snapshot: { kind: "workflow", status: "running" },
        details: {
          status: "running",
          plan: { executionOrder: ["review"] },
          runningTaskIds: ["review"],
          needsReconciliation: false,
          reconciliationPlan: { actions: [] },
        },
      });
  });

  it("cancels a Workflow through JobCancel instead of a Workflow action", async () => {
    const cwd = temporaryDirectory();
    const spec = { mode: "sequential" as const, tasks: [{ id: "review" }] };
    new FileWorkflowRunRepository({ cwd }).save(createWorkflowRunSnapshot({
      runId: "workflow-cancel",
      ownerSession: "session-1",
      status: "running",
      summary: "queued",
      spec,
      plan: createWorkflowPlan(spec),
      results: new Map(),
      running: new Set(),
      createdAt: 10,
    }));
    const host = new LocalAgentJobHost(cwd, "session-1", directory());

    await expect(host.cancel({
      sessionId: "session-1",
      jobId: "workflow-cancel",
      reason: "no longer needed",
    })).resolves.toMatchObject({
      id: "workflow-cancel",
      kind: "workflow",
      status: "killed",
      capabilities: { cancel: false },
    });
    expect(new FileWorkflowRunRepository({ cwd }).load("workflow-cancel")).toMatchObject({
      status: "failed",
      termination: "cancelled",
      summary: "no longer needed",
    });
  });
});

function directory(...handles: AgentChildHandle[]): AgentChildDirectory {
  return {
    get: (id) => handles.find((handle) => handle.id === id),
    getBySessionId: (sessionId) => handles.find((handle) => handle.sessionId === sessionId),
    list: () => handles,
  };
}

function temporaryDirectory(): string {
  const cwd = mkdtempSync(join(tmpdir(), "openharness-local-jobs-"));
  createdDirectories.push(cwd);
  return cwd;
}
