import { describe, expect, it, vi } from "vitest";

import { SessionPostRunMaintenance } from "../session-post-run-maintenance.js";

function createStore(runStatus = "completed") {
  return {
    getSession: vi.fn(() => ({ id: "s1", cwd: "/repo", model: "gpt-test", updatedAt: 20 })),
    getRun: vi.fn(() => ({ id: "run-1", sessionId: "s1", status: runStatus })),
    listMessages: vi.fn(() => [{ id: "m1", seq: 1, role: "user" }]),
    listMessageParts: vi.fn(() => [{ id: "p1", seq: 1, text: "use pnpm" }]),
  };
}

describe("SessionPostRunMaintenance", () => {
  it("writes continuity and extracts governed context after a completed run", async () => {
    const sessionMemoryWriter = vi.fn();
    const contextExtractor = vi.fn(async () => {});
    const maintenance = new SessionPostRunMaintenance({
      store: createStore() as any,
      getSettings: vi.fn(async () => ({
        sessionContinuity: { enabled: true },
        context: { enabled: true, automaticExtractionEnabled: true },
      } as any)),
      sessionMemoryWriter,
      contextExtractor,
      log: vi.fn(),
    });

    await maintenance.run("s1", "run-1");

    expect(sessionMemoryWriter).toHaveBeenCalledWith(
      "/repo",
      [{ role: "user", content: "use pnpm" }],
      "s1",
    );
    expect(contextExtractor).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1",
      runId: "run-1",
      cwd: "/repo",
    }));
  });

  it("does nothing for a non-completed run", async () => {
    const getSettings = vi.fn();
    const maintenance = new SessionPostRunMaintenance({
      store: createStore("failed") as any,
      getSettings,
      log: vi.fn(),
    });
    await maintenance.run("s1", "run-1");
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("honors independent continuity and context switches", async () => {
    const sessionMemoryWriter = vi.fn();
    const contextExtractor = vi.fn();
    const maintenance = new SessionPostRunMaintenance({
      store: createStore() as any,
      getSettings: vi.fn(async () => ({
        sessionContinuity: { enabled: false },
        context: { enabled: false, automaticExtractionEnabled: true },
      } as any)),
      sessionMemoryWriter,
      contextExtractor,
      log: vi.fn(),
    });
    await maintenance.run("s1", "run-1");
    expect(sessionMemoryWriter).not.toHaveBeenCalled();
    expect(contextExtractor).not.toHaveBeenCalled();
  });

  it("does not fail the completed run when loading settings fails", async () => {
    const log = vi.fn();
    const maintenance = new SessionPostRunMaintenance({
      store: createStore() as any,
      getSettings: vi.fn(async () => { throw new Error("bad settings"); }),
      log,
    });
    await expect(maintenance.run("s1", "run-1")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      event: "session.post_run_maintenance_failed",
      error: "bad settings",
    }));
  });
});
