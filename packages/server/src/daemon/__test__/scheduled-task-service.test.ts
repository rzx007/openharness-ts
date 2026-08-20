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

  it("does not skip-storm when a task is updated while a run is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T10:00:00Z"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return {
        sessionId: "chat-1",
        runId: "slow-run",
        summary: "Still running.",
      };
    });
    const { service, store } = createHarness(execute);
    const task = service.createTask({
      name: "live-update",
      prompt: "Original prompt.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });
    // Leave a past nextRunAt so a naive install would arm setTimeout(0).
    store.updateScheduledTask(task.id, {
      nextRunAt: Date.parse("2026-08-20T09:00:00Z"),
    });

    const running = service.trigger(task.id);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();

    service.updateTask(task.id, { prompt: "Updated prompt during run." });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      store
        .listScheduledRuns({ taskId: task.id })
        .filter((run) => run.status === "skipped"),
    ).toHaveLength(0);

    release();
    await running;
    // Only probe the near term — do not jump to the next daily fire.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(execute).toHaveBeenCalledOnce();
    expect(
      store
        .listScheduledRuns({ taskId: task.id })
        .filter((run) => run.status === "skipped"),
    ).toHaveLength(0);
    expect(store.getScheduledTask(task.id)?.prompt).toBe(
      "Updated prompt during run.",
    );
  });

  it("applies recurrence changes made during a run instead of completing as once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await gate;
      return {
        sessionId: "chat-1",
        runId: "convert-run",
        summary: "Converted to recurring.",
      };
    });
    const { service, store } = createHarness(execute);
    const task = service.createTask({
      name: "once-to-rrule",
      prompt: "Run once, then become daily.",
      recurrence: "2099-01-01T00:00:00Z",
      recurrenceFormat: "once",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });

    const running = service.trigger(task.id);
    await Promise.resolve();
    service.updateTask(task.id, {
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule",
    });
    release();
    await running;

    const updated = store.getScheduledTask(task.id);
    expect(updated).toMatchObject({
      status: "active",
      recurrenceFormat: "rrule",
      runCount: 1,
    });
    expect(updated?.nextRunAt).toBeTypeOf("number");
  });

  it("completes exhausted RRULEs instead of re-firing forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
    const execute = vi.fn(async () => ({
      sessionId: "chat-1",
      runId: "final-run",
      summary: "Last occurrence.",
    }));
    const { service, store } = createHarness(execute);
    const task = service.createTask({
      name: "until-exhausted",
      prompt: "Final window.",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=11;BYMINUTE=0",
      recurrenceFormat: "rrule",
      timezone: "UTC",
      destination: "chat",
      sessionId: "chat-1",
    });
    // Exhaust the rule after creation so finishTask must handle no next fire.
    store.updateScheduledTask(task.id, {
      recurrence:
        "RRULE:FREQ=DAILY;BYHOUR=11;BYMINUTE=0;UNTIL=20260820T110000Z",
      nextRunAt: Date.parse("2026-08-20T11:00:00Z"),
      status: "active",
    });

    const run = await service.trigger(task.id);
    expect(run.status).toBe("succeeded");
    expect(store.getScheduledTask(task.id)).toMatchObject({
      status: "completed",
      runCount: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledOnce();
  });
});
