import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "@openharness/services";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScheduledTaskService } from "../scheduled-task-service.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.useRealTimers();
});

function createHarness(
  execute = vi.fn(async () => ({
    sessionId: "scheduled-session",
    runId: "agent-run",
    summary: "Agent completed the scheduled work.",
  })),
) {
  const dir = mkdtempSync(join(tmpdir(), "ohs-scheduled-service-"));
  const store = new SessionStore({ path: join(dir, "store.db") });
  const service = new ScheduledTaskService({ store, execute });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { execute, service, store };
}

describe("ScheduledTaskService", () => {
  it("runs a saved Agent prompt and projects its Session run result", async () => {
    const { execute, service, store } = createHarness();
    const task = service.createTask({
      name: "deployment-follow-up",
      prompt: "Check the deployment and report the result.",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      createdBy: "agent",
      createdFromSessionId: "chat-1",
    });

    const run = await service.trigger(task.id);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        prompt: expect.stringContaining("deployment"),
      }),
      expect.objectContaining({ taskId: task.id, cause: "manual" }),
    );
    expect(run).toMatchObject({
      status: "succeeded",
      sessionId: "scheduled-session",
      runId: "agent-run",
      unread: true,
    });
    expect(store.getScheduledTask(task.id)).toMatchObject({
      status: "completed",
      runCount: 1,
    });
  });

  it("preserves worktree intent without silently changing it to local execution", () => {
    const { service } = createHarness();
    const task = service.createTask({
      name: "isolated-review",
      prompt: "Review the repository.",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "standalone",
      projectPaths: [process.cwd()],
      executionMode: "worktree",
    });

    expect(task.executionMode).toBe("worktree");
    expect(() =>
      service.createTask({
        name: "invalid-chat-worktree",
        prompt: "Review the repository.",
        recurrence: "2099-01-01T00:00:00Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "chat",
        sessionId: "chat-1",
        executionMode: "worktree",
      }),
    ).toThrow(/standalone destination/);
    expect(() =>
      service.createTask({
        name: "invalid-chat-policy",
        prompt: "Review without writes.",
        recurrence: "2099-01-01T00:00:00Z",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "chat",
        sessionId: "chat-1",
        permissionProfile: { mode: "read_only" },
      }),
    ).toThrow(/inherit their conversation runtime/);
  });

  it("runs one missed occurrence after daemon recovery when requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T09:00:00Z"));
    const dir = mkdtempSync(join(tmpdir(), "ohs-scheduled-recovery-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    store.createScheduledTask({
      id: "missed-task",
      name: "missed-review",
      prompt: "Review the missed interval.",
      recurrence: "2026-08-18T08:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      missedRunPolicy: "run_once",
      nextRunAt: Date.parse("2026-08-18T08:00:00Z"),
    });
    const execute = vi.fn(async () => ({
      sessionId: "chat-1",
      runId: "recovered-run",
      summary: "Recovered missed run.",
    }));
    const service = new ScheduledTaskService({ store, execute });
    cleanups.push(async () => {
      await service.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    await vi.runAllTimersAsync();

    expect(execute).toHaveBeenCalledOnce();
    expect(store.getScheduledTask("missed-task")).toMatchObject({
      status: "completed",
      runCount: 1,
    });
  });

  it("completes a recurring task after a successful run when requested", async () => {
    const { service, store } = createHarness();
    const task = service.createTask({
      name: "finish-on-success",
      prompt: "Complete the recurring objective.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
      stopPolicy: { stopWhenCompleted: true },
    });

    await service.trigger(task.id);

    const completed = store.getScheduledTask(task.id);
    expect(completed).toMatchObject({
      status: "completed",
      runCount: 1,
    });
    expect(completed?.nextRunAt).toBeUndefined();
  });
});
