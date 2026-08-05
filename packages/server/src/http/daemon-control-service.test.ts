import { describe, expect, it, vi } from "vitest";

import { DaemonControlService } from "./daemon-control-service.js";

function createControl() {
  const sessions = [
    { id: "s1", status: "idle" },
    { id: "s2", status: "archived" },
  ];
  const store = {
    listSessions: vi.fn(() => sessions),
    listRuns: vi.fn((sessionId) => sessionId === "s1" ? [{ status: "running" }] : []),
    listSessionTasks: vi.fn(() => []),
    listPermissionRequests: vi.fn(() => [{ status: "pending" }]),
    getSession: vi.fn((sessionId) => sessions.find((session) => session.id === sessionId)),
  };
  const runEngine = {
    activeRunId: vi.fn((sessionId) => sessionId === "s1" ? "run-1" : undefined),
    queuedRunIds: vi.fn((sessionId) => sessionId === "s1" ? ["run-2"] : []),
    hasAnyActiveRuns: vi.fn(() => true),
    hasActiveRunsForCwd: vi.fn(() => false),
  };
  const runtime = { inspect: vi.fn(async () => ({ hooks: [{ id: "hook-1", origin: "runtime" }] })) };
  const runtimePool = {
    configured: true,
    size: 1,
    warm: vi.fn(async () => {}),
    get: vi.fn(async () => runtime),
    closeAll: vi.fn(async () => {}),
    closeForCwd: vi.fn(async () => {}),
  };
  const control = new DaemonControlService({
    store: store as any,
    runEngine: runEngine as any,
    runtimePool: runtimePool as any,
    startedAt: Date.now() - 100,
    sseClientCount: () => 2,
  });
  return { control, store, runEngine, runtimePool };
}

describe("DaemonControlService", () => {
  it("builds the daemon runtime snapshot from authoritative owners", () => {
    const { control } = createControl();

    const snapshot = control.runtimeSnapshot();

    expect(snapshot).toMatchObject({
      sessions: { total: 2, byStatus: { idle: 1, archived: 1 } },
      runs: { total: 1, byStatus: { running: 1 } },
      permissions: { total: 1, byStatus: { pending: 1 } },
      sseClientCount: 2,
      warmRuntimeCount: 1,
      coordinator: { activeRunCount: 1, queuedRunCount: 1 },
    });
  });

  it("inspects hooks through the shared runtime pool", async () => {
    const { control, runtimePool } = createControl();

    await expect(control.inspectRuntimeHooks("s1")).resolves.toEqual([
      { id: "hook-1", origin: "runtime" },
    ]);
    expect(runtimePool.warm).toHaveBeenCalledWith("s1");
  });
});
