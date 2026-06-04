import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "./index.js";

const NODE = process.execPath;

function tempTasksDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-tasks-"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const managers: TaskManager[] = [];
function makeManager(): TaskManager {
  const mgr = new TaskManager(tempTasksDir());
  managers.push(mgr);
  return mgr;
}

afterEach(async () => {
  while (managers.length) {
    const mgr = managers.pop()!;
    await mgr.aclose().catch(() => {});
  }
});

describe("TaskManager real execution", () => {
  it("runs a shell task and captures output to the log file", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stdout.write('hello-shell')"`,
      "echo via node",
      process.cwd(),
    );
    expect(task.status).toBe("running");
    expect(task.outputFile).toBeTruthy();
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    const out = mgr.readTaskOutput(task.id);
    expect(out).toContain("hello-shell");
    expect(mgr.getTask(task.id)!.exitCode).toBe(0);
  });

  it("captures stderr and marks non-zero exit as failed", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stderr.write('boom'); process.exit(3)"`,
      "failing task",
      process.cwd(),
    );
    await waitFor(() => mgr.getTask(task.id)!.status === "failed");
    expect(mgr.getTask(task.id)!.exitCode).toBe(3);
    expect(mgr.readTaskOutput(task.id)).toContain("boom");
  });

  it("runs an argv (direct-exec) task without a shell", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask({
      argv: [NODE, "-e", "process.stdout.write('argv-out')"],
      description: "argv task",
      cwd: process.cwd(),
    });
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    expect(mgr.readTaskOutput(task.id)).toContain("argv-out");
  });

  it("writes to task stdin and the child echoes it back", async () => {
    const mgr = makeManager();
    // Reads one line from stdin and echoes it, then exits.
    const script =
      "let buf='';process.stdin.on('data',d=>{buf+=d;const i=buf.indexOf('\\n');" +
      "if(i>=0){process.stdout.write('got:'+buf.slice(0,i));process.exit(0);}});";
    const task = await mgr.createShellTask({
      argv: [NODE, "-e", script],
      description: "stdin reader",
      cwd: process.cwd(),
    });
    await mgr.writeToTask(task.id, "ping");
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    expect(mgr.readTaskOutput(task.id)).toContain("got:ping");
  });

  it("wraps multi-line stdin payloads as a single JSON frame", async () => {
    const mgr = makeManager();
    const script =
      "let buf='';process.stdin.on('data',d=>{buf+=d;const i=buf.indexOf('\\n');" +
      "if(i>=0){process.stdout.write(buf.slice(0,i));process.exit(0);}});";
    const task = await mgr.createShellTask({
      argv: [NODE, "-e", script],
      description: "stdin json frame",
      cwd: process.cwd(),
    });
    await mgr.writeToTask(task.id, "line1\nline2");
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    const out = mgr.readTaskOutput(task.id);
    const parsed = JSON.parse(out.trim());
    expect(parsed.text).toBe("line1\nline2");
  });

  it("fires completion listeners on terminal state", async () => {
    const mgr = makeManager();
    const seen: string[] = [];
    mgr.registerCompletionListener((t) => {
      seen.push(`${t.id}:${t.status}`);
    });
    const task = await mgr.createShellTask(
      `${NODE} -e "process.exit(0)"`,
      "completes",
      process.cwd(),
    );
    await waitFor(() => seen.length > 0);
    expect(seen).toContain(`${task.id}:completed`);
  });

  it("unregister stops further listener notifications", async () => {
    const mgr = makeManager();
    let count = 0;
    const unregister = mgr.registerCompletionListener(() => {
      count++;
    });
    unregister();
    await mgr.createShellTask(`${NODE} -e "process.exit(0)"`, "x", process.cwd());
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(0);
  });

  it("stops a long-running task and terminates the process", async () => {
    const mgr = makeManager();
    const seen: string[] = [];
    mgr.registerCompletionListener((t) => seen.push(t.status));
    const task = await mgr.createShellTask(
      `${NODE} -e "setInterval(()=>{},1000)"`,
      "long runner",
      process.cwd(),
    );
    expect(mgr.getTask(task.id)!.status).toBe("running");
    const stopped = await mgr.stopTask(task.id);
    expect(stopped.status).toBe("stopped");
    expect(seen).toContain("stopped");
  });

  it("auto-restarts a crashing agent task up to the limit", async () => {
    const mgr = makeManager();
    // Agent task with an explicit argv that always exits non-zero quickly.
    const task = await mgr.createAgentTask({
      prompt: "go",
      description: "crash loop agent",
      cwd: process.cwd(),
      argv: [NODE, "-e", "process.exit(1)"],
    });
    // It should burn through restarts and finally land in failed with the limit note.
    await waitFor(() => {
      const t = mgr.getTask(task.id)!;
      return t.status === "failed" && (t.metadata.status_note ?? "").includes("restart limit");
    }, 15000);
    const t = mgr.getTask(task.id)!;
    expect(parseInt(t.metadata.restart_count ?? "0", 10)).toBeGreaterThanOrEqual(5);
  });

  it("agent task without argv/command is failed with needs-argv, not pending", async () => {
    const mgr = makeManager();
    const task = await mgr.createAgentTask("do work", "no argv", process.cwd());
    expect(task.status).toBe("failed");
    expect(task.metadata.needs_argv).toBe("1");
    expect(mgr.readTaskOutput(task.id)).toContain("argv");
  });

  it("agent task with argv spawns and runs", async () => {
    const mgr = makeManager();
    const task = await mgr.createAgentTask({
      prompt: "hi-agent",
      description: "agent argv",
      cwd: process.cwd(),
      // Reads the forwarded prompt from stdin and echoes it.
      argv: [
        NODE,
        "-e",
        "let b='';process.stdin.on('data',d=>{b+=d;const i=b.indexOf('\\n');if(i>=0){process.stdout.write('agent:'+b.slice(0,i));process.exit(0);}});",
      ],
    });
    expect(task.type).toBe("agent");
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    expect(mgr.readTaskOutput(task.id)).toContain("agent:hi-agent");
  });

  it("aclose terminates all running tasks", async () => {
    const mgr = new TaskManager(tempTasksDir());
    const t1 = await mgr.createShellTask(
      `${NODE} -e "setInterval(()=>{},1000)"`,
      "runner 1",
      process.cwd(),
    );
    expect(mgr.getTask(t1.id)!.status).toBe("running");
    await mgr.aclose();
    // No more tracked processes — a subsequent stop reports not-running terminal handling.
    // The task record is retained but the process is gone.
    expect(mgr.getTask(t1.id)).toBeTruthy();
  });

  it("throws when neither command nor argv is provided to createShellTask", async () => {
    const mgr = makeManager();
    await expect(
      mgr.createShellTask({ description: "empty", cwd: process.cwd() }),
    ).rejects.toThrow(/command or argv/);
  });

  it("writeToTask rejects for a non-agent task whose process has exited", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask(
      `${NODE} -e "process.exit(0)"`,
      "short",
      process.cwd(),
    );
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    await expect(mgr.writeToTask(task.id, "late")).rejects.toThrow(/does not accept input/);
  });
});
