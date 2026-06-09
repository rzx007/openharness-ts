import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "./index.js";

const NODE = process.execPath;

function tempTasksDir(): string {
  return mkdtempSync(join(tmpdir(), "oh-tasks-"));
}

/** Probe whether a pid is still alive. `kill(pid, 0)` performs no signalling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH => no such process. EPERM => alive but not ours (treat as alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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

  it("stopping a shell task kills shell-spawned grandchildren (whole process tree)", async () => {
    const mgr = makeManager();
    const dir = tempTasksDir();
    const pidFile = join(dir, "grandchild.pid");
    const readyFile = join(dir, "ready");

    // A node grandchild that records its own pid, signals readiness, and then
    // sleeps forever. It is launched as a *child of the shell*, so a naive
    // single-process kill of the shell would leave it orphaned and alive.
    const grandchildJs =
      `const fs=require('fs');` +
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      `fs.writeFileSync(${JSON.stringify(readyFile)}, '1');` +
      `setInterval(()=>{},1000);`;

    let command: string;
    if (process.platform === "win32") {
      // Start the grandchild as a separate process, then keep the shell alive.
      command =
        `start /b "" "${NODE}" -e "${grandchildJs.replace(/"/g, '""')}" & ` +
        `"${NODE}" -e "setInterval(()=>{},1000)"`;
    } else {
      // Background the grandchild under the shell, then keep the shell alive.
      command =
        `'${NODE}' -e '${grandchildJs.replace(/'/g, "'\\''")}' & ` +
        `'${NODE}' -e 'setInterval(()=>{},1000)'`;
    }

    const task = await mgr.createShellTask(command, "tree with grandchild", process.cwd());
    await waitFor(() => existsSync(pidFile) && existsSync(readyFile), 8000);
    const grandPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(Number.isFinite(grandPid)).toBe(true);

    await mgr.stopTask(task.id);

    // After stop, the grandchild must no longer be alive. On POSIX we probe via
    // signal 0; on Windows the process-group kill is exercised through the same
    // stop path (taskkill /T), and we likewise verify the pid is gone.
    await waitFor(() => !isAlive(grandPid), 8000);
    expect(isAlive(grandPid)).toBe(false);
  });

  it("does NOT auto-restart an agent task that exits on its own (mirrors Python _watch_process)", async () => {
    const mgr = makeManager();
    // Agent task whose argv exits non-zero immediately. Python's _watch_process
    // only records terminal state; it never proactively restarts on exit.
    const task = await mgr.createAgentTask({
      prompt: "go",
      description: "crash-on-exit agent",
      cwd: process.cwd(),
      argv: [NODE, "-e", "process.exit(1)"],
    });
    await waitFor(() => mgr.getTask(task.id)!.status === "failed");
    // Give any (incorrect) restart loop a window to fire — it must not.
    await new Promise((r) => setTimeout(r, 400));
    const t = mgr.getTask(task.id)!;
    expect(t.status).toBe("failed");
    expect(t.exitCode).toBe(1);
    // No restart was triggered by the exit itself.
    expect(parseInt(t.metadata.restart_count ?? "0", 10)).toBe(0);
  });

  it("restarts a dead agent on write (broken pipe) and bounds restarts by the limit", async () => {
    const mgr = makeManager();
    // Agent that reads one line, echoes it, then exits — so each write after the
    // first lands on a dead process and forces a lazy restart.
    const script =
      "let b='';process.stdin.on('data',d=>{b+=d;const i=b.indexOf('\\n');" +
      "if(i>=0){process.stdout.write('echo:'+b.slice(0,i)+'\\n');process.exit(0);}});";
    const task = await mgr.createAgentTask({
      prompt: "first",
      description: "restart-on-write agent",
      cwd: process.cwd(),
      argv: [NODE, "-e", script],
    });
    // Wait for the initial process to consume the prompt and exit.
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    expect(parseInt(mgr.getTask(task.id)!.metadata.restart_count ?? "0", 10)).toBe(0);

    // Each subsequent write must lazily restart the dead agent. Drive it past
    // the restart limit (5) so the (limit+1)-th write rejects.
    let rejected = false;
    for (let i = 0; i < 7; i++) {
      try {
        await mgr.writeToTask(task.id, `msg-${i}`);
        // Let the freshly spawned child consume the line and exit again.
        await waitFor(() => mgr.getTask(task.id)!.status === "completed", 5000);
      } catch (e) {
        rejected = true;
        expect((e as Error).message).toMatch(/restart limit/);
        break;
      }
    }
    expect(rejected).toBe(true);
    expect(parseInt(mgr.getTask(task.id)!.metadata.restart_count ?? "0", 10)).toBe(5);
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

describe("TaskManager.awaitTask", () => {
  it("returns immediately for an already-terminal task with its output/status", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stdout.write('done-out'); process.exit(0)"`,
      "fast",
      process.cwd(),
    );
    await waitFor(() => mgr.getTask(task.id)!.status === "completed");
    const res = await mgr.awaitTask(task.id);
    expect(res.status).toBe("completed");
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("done-out");
    expect(res.timedOut).toBeUndefined();
  });

  it("resolves with failed status for a non-zero exit", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask(
      `${NODE} -e "process.stderr.write('nope'); process.exit(2)"`,
      "fails",
      process.cwd(),
    );
    await waitFor(() => mgr.getTask(task.id)!.status === "failed");
    const res = await mgr.awaitTask(task.id);
    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(2);
    expect(res.output).toContain("nope");
  });

  it("resolves when a still-running task completes", async () => {
    const mgr = makeManager();
    // Sleep briefly, then emit output and exit — task is running at await time.
    const task = await mgr.createShellTask(
      `${NODE} -e "setTimeout(()=>{process.stdout.write('late-out');process.exit(0);},300)"`,
      "slow",
      process.cwd(),
    );
    expect(mgr.getTask(task.id)!.status).toBe("running");
    const res = await mgr.awaitTask(task.id);
    expect(res.status).toBe("completed");
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("late-out");
    expect(res.timedOut).toBeUndefined();
  });

  it("returns timedOut:true for a long-running task that exceeds timeoutMs", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask(
      `${NODE} -e "setInterval(()=>{},1000)"`,
      "long",
      process.cwd(),
    );
    const res = await mgr.awaitTask(task.id, { timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
    expect(res.status).toBe("running");
    // Still running after the timeout — not yet terminal.
    expect(mgr.getTask(task.id)!.status).toBe("running");
  });

  it("does not resolve early before the timeout when the task keeps running", async () => {
    const mgr = makeManager();
    const task = await mgr.createShellTask(
      `${NODE} -e "setInterval(()=>{},1000)"`,
      "long2",
      process.cwd(),
    );
    const start = Date.now();
    const res = await mgr.awaitTask(task.id, { timeoutMs: 250 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  it("throws for an unknown taskId", () => {
    const mgr = makeManager();
    expect(() => mgr.awaitTask("task_does_not_exist")).toThrow(/not found/i);
  });
});

describe("TaskManager.registerTaskListener", () => {
  it("fires 'created' when a task is created", async () => {
    const mgr = makeManager();
    const events: Array<{ id: string; event: string; status: string }> = [];
    mgr.registerTaskListener((t, event) => {
      events.push({ id: t.id, event, status: t.status });
    });
    const task = await mgr.createShellTask(
      `${NODE} -e "process.exit(0)"`,
      "create-event",
      process.cwd(),
    );
    const created = events.find((e) => e.id === task.id && e.event === "created");
    expect(created).toBeTruthy();
    expect(created!.status).toBe("running");
  });

  it("fires 'completed' when a task reaches a terminal state", async () => {
    const mgr = makeManager();
    const events: Array<{ id: string; event: string; status: string }> = [];
    mgr.registerTaskListener((t, event) => {
      events.push({ id: t.id, event, status: t.status });
    });
    const task = await mgr.createShellTask(
      `${NODE} -e "process.exit(0)"`,
      "complete-event",
      process.cwd(),
    );
    await waitFor(() => events.some((e) => e.id === task.id && e.event === "completed"));
    const completed = events.find((e) => e.id === task.id && e.event === "completed");
    expect(completed!.status).toBe("completed");
  });

  it("the returned unregister callback stops further events", async () => {
    const mgr = makeManager();
    let count = 0;
    const unregister = mgr.registerTaskListener(() => {
      count++;
    });
    unregister();
    await mgr.createShellTask(`${NODE} -e "process.exit(0)"`, "x", process.cwd());
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(0);
  });

  it("isolates a throwing listener from the others", async () => {
    const mgr = makeManager();
    const seen: string[] = [];
    mgr.registerTaskListener(() => {
      throw new Error("boom in listener");
    });
    mgr.registerTaskListener((t, event) => {
      if (event === "created") seen.push(t.id);
    });
    const task = await mgr.createShellTask(
      `${NODE} -e "process.exit(0)"`,
      "isolate",
      process.cwd(),
    );
    expect(seen).toContain(task.id);
  });

  it("fires both 'created' and 'completed' for an agent task missing argv (failed early)", async () => {
    const mgr = makeManager();
    const events: string[] = [];
    mgr.registerTaskListener((_t, event) => events.push(event));
    await mgr.createAgentTask("do work", "no argv", process.cwd());
    expect(events).toContain("created");
    expect(events).toContain("completed");
  });
});
