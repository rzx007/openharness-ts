import type { AgentJobHost, JobSnapshot } from "@openharness/jobs";
import { describe, expect, it, vi } from "vitest";

import { jobCancelTool, jobListTool, jobReadTool, jobWaitTool } from "./job-tools.js";

const snapshot: JobSnapshot = {
  id: "terminal-1",
  kind: "terminal",
  label: "dev server",
  ownerSession: "session-1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/repo",
  startedAt: 1,
  updatedAt: 2,
};

describe("job tools", () => {
  it("lists only through the durable session owner", async () => {
    const list = vi.fn(async () => [snapshot]);
    const result = await jobListTool.execute({}, context({ list }));
    expect(list).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(payload(result)).toMatchObject({ kind: "job", action: "list", jobs: [{ id: "terminal-1" }] });
  });

  it("forwards read cursors and output limits", async () => {
    const read = vi.fn(async () => ({ text: "next", cursor: 4, truncated: false, snapshot }));
    await jobReadTool.execute({ jobId: "terminal-1", after: 3, maxChars: 40 }, context({ read }));
    expect(read).toHaveBeenCalledWith({
      sessionId: "session-1",
      jobId: "terminal-1",
      after: 3,
      maxChars: 40,
    });
  });

  it("waits without turning timeout into cancellation", async () => {
    const wait = vi.fn(async () => ({ text: "", cursor: 4, truncated: false, snapshot, timedOut: true }));
    const cancel = vi.fn(async () => snapshot);
    const result = await jobWaitTool.execute({ jobId: "terminal-1", timeoutSeconds: 2 }, context({ wait, cancel }));
    expect(payload(result)).toMatchObject({ action: "wait", timedOut: true });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels through the common host", async () => {
    const cancel = vi.fn(async () => ({ ...snapshot, status: "stopping" as const }));
    await jobCancelTool.execute({ jobId: "terminal-1", reason: "done" }, context({ cancel }));
    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1", jobId: "terminal-1", reason: "done" });
  });
});

function context(overrides: Partial<AgentJobHost>) {
  const jobs: AgentJobHost = {
    list: async () => [],
    read: async () => ({ text: "", cursor: 0, truncated: false, snapshot }),
    wait: async () => ({ text: "", cursor: 0, truncated: false, snapshot, timedOut: false }),
    send: async () => undefined,
    cancel: async () => snapshot,
    ...overrides,
  };
  return { cwd: "/repo", sessionId: "session-1", jobs };
}

function payload(result: Awaited<ReturnType<typeof jobListTool.execute>>): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return JSON.parse(block.text) as Record<string, unknown>;
}
