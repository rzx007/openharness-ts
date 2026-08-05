import { describe, expect, it, vi } from "vitest";

import { DaemonChildSessionHost } from "./daemon-child-session-host.js";

describe("DaemonChildSessionHost", () => {
  it("exposes only the child-session application use cases", async () => {
    const child = { id: "child-1" };
    const application = {
      createChildSession: vi.fn(async () => child),
      admitPrompt: vi.fn(() => ({ run: { id: "run-1" } })),
      awaitRun: vi.fn(async () => ({ status: "completed" as const, output: "done" })),
      interruptSession: vi.fn(),
      closeRuntime: vi.fn(async () => {}),
      archiveSessionTree: vi.fn(async () => child),
    };
    const host = new DaemonChildSessionHost(() => application as any);

    await expect(host.createChildSession({
      parentId: "parent-1",
      cwd: "/repo",
      title: "Child",
      agent: "worker",
    })).resolves.toBe(child);
    await expect(host.admitPrompt("child-1", "work")).resolves.toEqual({ runId: "run-1" });
    await expect(host.awaitRun("child-1", "run-1")).resolves.toEqual({ status: "completed", output: "done" });
    await host.interrupt("child-1");
    await host.closeRuntime("child-1");
    await host.archive("child-1");

    expect(application.admitPrompt).toHaveBeenCalledWith("child-1", { content: "work" });
    expect(application.interruptSession).toHaveBeenCalledWith("child-1");
    expect(application.closeRuntime).toHaveBeenCalledWith("child-1");
    expect(application.archiveSessionTree).toHaveBeenCalledWith("child-1");
  });
});
