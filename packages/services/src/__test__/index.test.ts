import { afterEach, describe, it, expect, vi } from "vitest";
import { CompactService } from "../compact/index.js";
import { estimateTokens } from "../token-estimation/index.js";
import { LspClient } from "../lsp/index.js";
import { TaskManager } from "../tasks/index.js";
import type { Message } from "@openharness/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskManagers: TaskManager[] = [];

function createTestTaskManager(): TaskManager {
  const manager = new TaskManager(mkdtempSync(join(tmpdir(), "oh-services-task-")));
  taskManagers.push(manager);
  return manager;
}

afterEach(() => {
  vi.useRealTimers();
  while (taskManagers.length > 0) taskManagers.pop()!.close();
});

describe("CompactService", () => {
  it("returns messages unchanged when under limit", () => {
    const svc = new CompactService(100_000, 10);
    const msgs: Message[] = [
      { type: "system", content: "sys" },
      { type: "user", content: "hi" },
    ];
    expect(svc.compact(msgs)).toEqual(msgs);
  });

  it("compacts when over limit preserving system message", () => {
    const svc = new CompactService(100_000, 2);
    const msgs: Message[] = [
      { type: "system", content: "sys" },
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "user" as const,
        content: `msg ${i}`,
      })),
    ];
    const result = svc.compact(msgs);
    expect(result.length).toBeLessThan(msgs.length);
    expect(result[0]).toEqual({ type: "system", content: "sys" });
    expect(result[1].type).toBe("assistant");
  });

  it("compacts without system message when keepRecent is small", () => {
    const svc = new CompactService(100_000, 2);
    const msgs: Message[] = [
      { type: "user", content: "msg 1" },
      { type: "user", content: "msg 2" },
      { type: "user", content: "msg 3" },
      { type: "user", content: "msg 4" },
      { type: "user", content: "msg 5" },
    ];
    const result = svc.compact(msgs);
    expect(result[0].type).not.toBe("system");
  });

  it("microCompact clears tool results", () => {
    const svc = new CompactService(100_000, 2);
    const msgs: Message[] = [
      { type: "user", content: "hi" },
      { type: "assistant", content: "let me check" },
      { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "long output here" }] },
      { type: "assistant", content: "done" },
    ];
    const result = svc.microCompact(msgs);
    expect(result.length).toBe(msgs.length);
  });
});

describe("estimateTokens", () => {
  it("estimates tokens as char/4", () => {
    const result = estimateTokens("hello world", "gpt-4");
    expect(result.tokens).toBe(3);
    expect(result.model).toBe("gpt-4");
  });

  it("uses default model", () => {
    const result = estimateTokens("test");
    expect(result.model).toBe("gpt-4");
  });

  it("handles empty string", () => {
    const result = estimateTokens("");
    expect(result.tokens).toBe(0);
  });
});

describe("LspClient", () => {
  it("surfaces strict sandbox unavailability instead of reporting no matches", async () => {
    const client = new LspClient({
      command: "",
      args: [],
      sessionId: "missing-lsp",
      settings: {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        sandbox: { enabled: true, backend: "docker", failIfUnavailable: true },
      },
    });
    await expect(client.workspaceSymbolSearch(process.cwd(), "QueryEngine"))
      .rejects.toThrow("Docker sandbox session is not running");
  });

  it("connects and disconnects", async () => {
    const client = new LspClient({
      command: "typescript-language-server",
      args: ["--stdio"],
    });
    expect(client.isConnected()).toBe(false);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });
});

describe("TaskManager", () => {
  it("creates a shell task and tracks it", async () => {
    const mgr = createTestTaskManager();
    const task = await mgr.createShellTask("echo hello", "test echo", process.cwd());
    expect(task.id).toMatch(/^task_\d+$/);
    expect(task.type).toBe("shell");
    expect(task.status).toBe("running");
    expect(mgr.getTask(task.id)).toBe(task);
  });

  it("lists tasks", async () => {
    const mgr = createTestTaskManager();
    await mgr.createShellTask("echo 1", "t1", process.cwd());
    await mgr.createAgentTask("do stuff", "t2", process.cwd());
    const tasks = mgr.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it("filters tasks by status", async () => {
    const mgr = createTestTaskManager();
    // Agent task without argv/command is marked failed (needs-argv), not silently pending.
    await mgr.createAgentTask("no-argv task", "desc", process.cwd());
    const failed = mgr.listTasks("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.type).toBe("agent");
  });

  it("creates an agent task without argv as failed needs-argv (no silent pending)", async () => {
    const mgr = createTestTaskManager();
    const task = await mgr.createAgentTask("write tests", "agent task", process.cwd(), "gpt-4");
    expect(task.type).toBe("agent");
    expect(task.status).toBe("failed");
    expect(task.metadata.needs_argv).toBe("1");
    expect(task.prompt).toBe("write tests");
  });

  it("readTaskOutput throws for unknown task", () => {
    const mgr = createTestTaskManager();
    expect(() => mgr.readTaskOutput("nope")).toThrow("not found");
  });

  it("stopTask throws for unknown task", async () => {
    const mgr = createTestTaskManager();
    await expect(mgr.stopTask("nope")).rejects.toThrow("not found");
  });

  it("writeToTask throws for unknown task", async () => {
    const mgr = createTestTaskManager();
    await expect(mgr.writeToTask("nope", "msg")).rejects.toThrow("not found");
  });

  it("shell task completes and produces output", async () => {
    const tasksDir = mkdtempSync(join(tmpdir(), "oh-services-task-"));
    const mgr = new TaskManager(tasksDir);
    try {
      const task = await mgr.createShellTask("echo done", "test", process.cwd());
      const result = await mgr.awaitTask(task.id, { timeoutMs: 5_000 });
      expect(result.output).toContain("done");
      expect(result.status).toBe("completed");
    } finally {
      mgr.close();
      rmSync(tasksDir, { recursive: true, force: true });
    }
  });
});
