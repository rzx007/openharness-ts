import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTaskManager, resetTaskManager } from "@openharness/services";
import { taskWaitTool } from "./index.js";

const NODE = process.execPath;
const CWD = mkdtempSync(join(tmpdir(), "oh-task-wait-"));

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

async function waitForStatus(taskId: string, status: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  const mgr = getTaskManager(CWD);
  while (mgr.getTask(taskId)?.status !== status) {
    if (Date.now() - start > timeoutMs) throw new Error(`task ${taskId} never reached ${status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  resetTaskManager(CWD);
  resetTaskManager({ cwd: CWD, sessionId: "session-timeout" });
});

describe("taskWaitTool", () => {
  it("waits for a single task and returns its output and status", async () => {
    const mgr = getTaskManager(CWD);
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stdout.write('done-single')"`,
      "quick task",
      CWD,
    );

    const result = await taskWaitTool.execute({ taskIds: [task.id] }, { cwd: CWD });
    const text = textOf(result);
    expect(text).toContain(task.id);
    expect(text).toContain("completed");
    expect(text).toContain("done-single");
    expect(result.isError).toBeFalsy();
  });

  it("accepts a single taskId passed as a bare string", async () => {
    const mgr = getTaskManager(CWD);
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stdout.write('bare-string')"`,
      "quick task",
      CWD,
    );

    const result = await taskWaitTool.execute({ taskIds: task.id }, { cwd: CWD });
    const text = textOf(result);
    expect(text).toContain(task.id);
    expect(text).toContain("bare-string");
  });

  it("waits for multiple tasks and reports each in its own segment", async () => {
    const mgr = getTaskManager(CWD);
    const a = await mgr.createShellTask(`${NODE} -e "process.stdout.write('out-A')"`, "A", CWD);
    const b = await mgr.createShellTask(`${NODE} -e "process.stdout.write('out-B')"`, "B", CWD);

    const result = await taskWaitTool.execute({ taskIds: [a.id, b.id] }, { cwd: CWD });
    const text = textOf(result);
    expect(text).toContain(a.id);
    expect(text).toContain("out-A");
    expect(text).toContain(b.id);
    expect(text).toContain("out-B");
  });

  it("reports a non-zero-exit task as failed with its output", async () => {
    const mgr = getTaskManager(CWD);
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stderr.write('boom'); process.exit(3)"`,
      "failing task",
      CWD,
    );

    const result = await taskWaitTool.execute({ taskIds: [task.id] }, { cwd: CWD });
    const text = textOf(result);
    expect(text).toContain(task.id);
    expect(text).toContain("failed");
    expect(text).toContain("boom");
  });

  it("marks a task that does not finish in time as timed out and requests stop", async () => {
    const mgr = getTaskManager(CWD);
    // Long-running task; we time out almost immediately.
    const task = await mgr.createShellTask(
      `${NODE} -e "setTimeout(() => {}, 60000)"`,
      "slow task",
      CWD,
    );

    const result = await taskWaitTool.execute({ taskIds: [task.id], timeoutSeconds: 0.2 }, { cwd: CWD });
    const text = textOf(result);
    expect(text).toContain(task.id);
    expect(text).toMatch(/did not finish within 0\.2s/);
    expect(text).toMatch(/已请求停止|requested stop/i);
    expect(mgr.getTask(task.id)?.status).toBe("stopped");
  });

  it("stops a session-backed task when TaskWait times out", async () => {
    const sessionId = "session-timeout";
    const mgr = getTaskManager({ cwd: CWD, sessionId });
    let stopped = false;
    const task = mgr.registerSessionTask({
      description: "session child",
      cwd: CWD,
      sessionId,
      childSessionId: "child-timeout",
      prompt: "work",
      onInput: async () => {},
      onStop: async () => {
        stopped = true;
      },
    });

    const result = await taskWaitTool.execute(
      { taskIds: [task.id], timeoutSeconds: 0.15 },
      { cwd: CWD, sessionId },
    );
    const text = textOf(result);
    expect(text).toMatch(/已请求停止|requested stop/i);
    expect(stopped).toBe(true);
    expect(mgr.getTask(task.id)?.status).toBe("stopped");
  });

  it("isolates an unknown taskId without dragging down the others", async () => {
    const mgr = getTaskManager(CWD);
    const good = await mgr.createShellTask(
      `${NODE} -e "process.stdout.write('good-output')"`,
      "good task",
      CWD,
    );

    const result = await taskWaitTool.execute(
      { taskIds: ["task_does_not_exist", good.id] },
      { cwd: CWD },
    );
    const text = textOf(result);
    // Unknown id reported as an error segment...
    expect(text).toContain("task_does_not_exist (error)");
    // ...but the good task still completes and reports its output.
    expect(text).toContain(good.id);
    expect(text).toContain("good-output");
    expect(result.isError).toBe(true);
  });

  it("errors when no taskIds are provided", async () => {
    const result = await taskWaitTool.execute({ taskIds: [] }, { cwd: CWD });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("required");
  });

  it("returns immediately for an already-finished task", async () => {
    const mgr = getTaskManager(CWD);
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stdout.write('already-done')"`,
      "quick task",
      CWD,
    );
    await waitForStatus(task.id, "completed");

    const result = await taskWaitTool.execute({ taskIds: [task.id] }, { cwd: CWD });
    expect(textOf(result)).toContain("already-done");
  });
});
