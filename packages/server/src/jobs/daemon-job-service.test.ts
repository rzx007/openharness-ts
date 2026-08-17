import type { SessionTaskRecord } from "@openharness/services";
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

const task: SessionTaskRecord = {
  id: "task-1",
  sessionId: "session-1",
  type: "agent",
  status: "running",
  description: "review",
  cwd: "/repo",
  metadata: { taskManagerId: "manager-1" },
  createdAt: 10,
  startedAt: 11,
  updatedAt: 12,
};

describe("DaemonJobService", () => {
  it("projects owned terminals and durable tasks into one list", async () => {
    const { service, projection } = createService();
    const jobs = await service.list({ sessionId: "session-1" });

    expect(projection.list).toHaveBeenCalledWith({ sessionId: "session-1" });
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
});

function createService() {
  const store = {
    getSession: vi.fn((id: string) => id === "session-1" ? { id, cwd: "/repo" } : undefined),
    listSessionTasks: vi.fn(() => [task]),
    getSessionTask: vi.fn((id: string) => id === task.id ? task : undefined),
  };
  const terminals = {
    list: vi.fn(async () => [terminal]),
    get: vi.fn(async () => terminal),
    readRequest: vi.fn(async () => ({ terminalId: terminal.id, data: "ready", sequence: 5, truncated: false })),
    write: vi.fn(),
    close: vi.fn(),
    wait: vi.fn(),
  };
  const projection = {
    list: vi.fn(() => ({ tasks: [task] })),
    stop: vi.fn(async () => ({ task })),
  };
  const manager = {
    readTaskOutput: vi.fn(() => "task output"),
    writeToTask: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => task),
  };
  return {
    service: new DaemonJobService(store as any, terminals as any, projection, () => manager),
    store,
    terminals,
    projection,
    manager,
  };
}
