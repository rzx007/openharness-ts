import { describe, it, expect } from "vitest";
import { CompactService } from "./compact/index.js";
import { SessionStorage } from "./session/index.js";
import { CronScheduler } from "./cron/index.js";
import { estimateTokens } from "./token-estimation/index.js";
import { LspClient } from "./lsp/index.js";
import { OAuthFlow } from "./oauth/index.js";
import { TaskManager } from "./tasks/index.js";
import type { Message } from "@openharness/core";

describe("CompactService", () => {
  it("returns messages unchanged when under limit", () => {
    const svc = new CompactService({ maxMessages: 10 });
    const msgs: Message[] = [
      { type: "system", content: "sys" },
      { type: "user", content: "hi" },
    ];
    expect(svc.compact(msgs)).toEqual(msgs);
  });

  it("compacts when over limit preserving system message", () => {
    const svc = new CompactService({ maxMessages: 4 });
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

  it("compacts without system message when preserveSystem is false", () => {
    const svc = new CompactService({ maxMessages: 4, preserveSystem: false });
    const msgs: Message[] = [
      { type: "system", content: "sys" },
      { type: "user", content: "msg 1" },
      { type: "user", content: "msg 2" },
      { type: "user", content: "msg 3" },
      { type: "user", content: "msg 4" },
      { type: "user", content: "msg 5" },
    ];
    const result = svc.compact(msgs);
    expect(result[0].type).not.toBe("system");
  });
});

describe("SessionStorage", () => {
  it("creates and retrieves a session", () => {
    const store = new SessionStorage();
    const session = store.create("s1", { foo: "bar" });
    expect(session.id).toBe("s1");
    expect(store.get("s1")).toBe(session);
  });

  it("updates session metadata", () => {
    const store = new SessionStorage();
    store.create("s1");
    const updated = store.update("s1", { status: "active" });
    expect(updated!.metadata.status).toBe("active");
  });

  it("update returns undefined for missing session", () => {
    const store = new SessionStorage();
    expect(store.update("nope", {})).toBeUndefined();
  });

  it("deletes a session", () => {
    const store = new SessionStorage();
    store.create("s1");
    expect(store.delete("s1")).toBe(true);
    expect(store.get("s1")).toBeUndefined();
  });

  it("lists all sessions", () => {
    const store = new SessionStorage();
    store.create("s1");
    store.create("s2");
    expect(store.list()).toHaveLength(2);
  });
});

describe("CronScheduler", () => {
  it("registers a job", () => {
    const scheduler = new CronScheduler();
    const job = scheduler.register("j1", "* * * * *", () => {});
    expect(job.id).toBe("j1");
    expect(job.expression).toBe("* * * * *");
    expect(job.running).toBe(false);
  });

  it("starts a job", () => {
    const scheduler = new CronScheduler();
    scheduler.register("j1", "* * * * *", () => {});
    expect(scheduler.start("j1")).toBe(true);
    const job = scheduler.register("j1", "* * * * *", () => {});
    scheduler.start("j1");
    scheduler.stop("j1");
  });

  it("start returns false for unknown job", () => {
    const scheduler = new CronScheduler();
    expect(scheduler.start("nope")).toBe(false);
  });

  it("stops a running job", () => {
    const scheduler = new CronScheduler();
    scheduler.register("j1", "* * * * *", () => {});
    scheduler.start("j1");
    expect(scheduler.stop("j1")).toBe(true);
  });

  it("stopAll stops all jobs", () => {
    const scheduler = new CronScheduler();
    scheduler.register("j1", "* * * * *", () => {});
    scheduler.register("j2", "0 * * * *", () => {});
    scheduler.start("j1");
    scheduler.start("j2");
    scheduler.stopAll();
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

describe("OAuthFlow", () => {
  it("generates authorization URL", () => {
    const oauth = new OAuthFlow({
      clientId: "my-app",
      authorizeUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      redirectUri: "http://localhost:3000/callback",
      scope: "read write",
    });
    const url = oauth.getAuthorizationUrl("random-state");
    expect(url).toContain("https://auth.example.com/authorize?");
    expect(url).toContain("client_id=my-app");
    expect(url).toContain("state=random-state");
    expect(url).toContain("scope=read+write");
  });

  it("exchangeCode returns tokens", async () => {
    const oauth = new OAuthFlow({
      clientId: "my-app",
      authorizeUrl: "",
      tokenUrl: "",
      redirectUri: "",
      scope: "",
    });
    const tokens = await oauth.exchangeCode("code123");
    expect(tokens.accessToken).toBeTruthy();
  });

  it("refreshTokens returns tokens", async () => {
    const oauth = new OAuthFlow({
      clientId: "my-app",
      authorizeUrl: "",
      tokenUrl: "",
      redirectUri: "",
      scope: "",
    });
    const tokens = await oauth.refreshTokens("refresh-123");
    expect(tokens.accessToken).toBeTruthy();
  });
});

describe("TaskManager", () => {
  it("creates a shell task and tracks it", async () => {
    const mgr = new TaskManager();
    const task = await mgr.createShellTask("echo hello", "test echo", process.cwd());
    expect(task.id).toMatch(/^task_\d+$/);
    expect(task.type).toBe("shell");
    expect(task.status).toBe("running");
    expect(mgr.getTask(task.id)).toBe(task);
  });

  it("lists tasks", async () => {
    const mgr = new TaskManager();
    await mgr.createShellTask("echo 1", "t1", process.cwd());
    await mgr.createAgentTask("do stuff", "t2", process.cwd());
    const tasks = mgr.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it("filters tasks by status", async () => {
    const mgr = new TaskManager();
    await mgr.createAgentTask("pending task", "desc", process.cwd());
    const pending = mgr.listTasks("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.type).toBe("agent");
  });

  it("creates an agent task", async () => {
    const mgr = new TaskManager();
    const task = await mgr.createAgentTask("write tests", "agent task", process.cwd(), "gpt-4");
    expect(task.type).toBe("agent");
    expect(task.status).toBe("pending");
    expect(task.prompt).toBe("write tests");
  });

  it("readTaskOutput throws for unknown task", () => {
    const mgr = new TaskManager();
    expect(() => mgr.readTaskOutput("nope")).toThrow("not found");
  });

  it("stopTask throws for unknown task", async () => {
    const mgr = new TaskManager();
    await expect(mgr.stopTask("nope")).rejects.toThrow("not found");
  });

  it("writeToTask throws for unknown task", async () => {
    const mgr = new TaskManager();
    await expect(mgr.writeToTask("nope", "msg")).rejects.toThrow("not found");
  });

  it("shell task completes and produces output", async () => {
    const mgr = new TaskManager();
    const task = await mgr.createShellTask("echo done", "test", process.cwd());
    await new Promise((r) => setTimeout(r, 500));
    const output = mgr.readTaskOutput(task.id);
    expect(output).toContain("done");
    expect(task.status).toBe("completed");
  });
});
