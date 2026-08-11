import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SessionStore, type SessionStoreOptions } from "./store.js";

function withStore(
  test: (store: SessionStore, path: string) => void,
  options: Omit<SessionStoreOptions, "path"> = {},
): void {
  const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-"));
  const path = join(dir, "store.db");
  const store = new SessionStore({ path, ...options });
  try {
    test(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SessionStore", () => {
  it("lists direct child sessions without mixing descendants or siblings", () => {
    withStore((store) => {
      store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "child-1", parentId: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "child-2", parentId: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "grandchild", parentId: "child-1", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "other", cwd: process.cwd(), model: "m" });

      expect(store.listChildSessions("parent").map((session) => session.id).sort()).toEqual([
        "child-1",
        "child-2",
      ]);
      expect(store.listChildSessions("child-1").map((session) => session.id)).toEqual(["grandchild"]);
    });
  });

  it("persists sessions and rehydrates from disk", () => {
    withStore((store, path) => {
      const session = store.createSession({
        id: "s1",
        cwd: process.cwd(),
        title: "main",
        model: "test-model",
        metadata: { source: "tui" },
      });

      const reloaded = new SessionStore({ path });
      expect(reloaded.getSession("s1")).toEqual(session);
      expect(reloaded.listSessions().map((row) => row.id)).toEqual(["s1"]);
      reloaded.close();
    });
  });

  it("does not read legacy JSON stores as a migration source", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-"));
    const path = join(dir, "legacy.json");
    try {
      writeFileSync(path, JSON.stringify({ sessions: { legacy: { id: "legacy" } } }), "utf-8");
      expect(() => new SessionStore({ path })).toThrow(/database/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts a pre-Drizzle SQLite schema without replacing session data", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-"));
    const path = join(dir, "store.db");
    try {
      const database = new Database(path);
      database.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY, parent_id TEXT, cwd TEXT NOT NULL, title TEXT NOT NULL,
          model TEXT NOT NULL, agent TEXT, status TEXT NOT NULL, metadata_json TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
        );
      `);
      database.prepare("INSERT INTO session VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)")
        .run("s1", process.cwd(), "existing", "m", "idle", "{}", 1, 1);
      database.close();

      const store = new SessionStore({ path });
      expect(store.getSession("s1")).toMatchObject({ id: "s1", title: "existing" });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates session model and emits session.updated", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "old" });
      const updated = store.updateSession("s1", { model: "new" });
      expect(updated.model).toBe("new");
      expect(store.listEvents().map((event) => event.type)).toContain("session.updated");
      expect(store.getSession("s1")?.model).toBe("new");
    });
  });

  it("replaces a session transcript atomically", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const old = store.createMessage({ id: "m1", sessionId: "s1", role: "user" });
      store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: old.id,
        type: "text",
        status: "completed",
        text: "old",
      });

      const replaced = store.replaceTranscript({
        sessionId: "s1",
        messages: [
          {
            role: "assistant",
            parts: [{ type: "text", status: "completed", text: "compacted summary" }],
          },
          {
            role: "user",
            parts: [{ type: "text", status: "completed", text: "recent" }],
          },
        ],
      });

      expect(replaced.messages).toHaveLength(2);
      expect(store.listMessages("s1").map((message) => message.id)).toEqual(
        replaced.messages.map((message) => message.id),
      );
      expect(store.listMessageParts("s1").map((part) => part.text)).toEqual([
        "compacted summary",
        "recent",
      ]);
      expect(store.listEvents().map((event) => event.type)).toContain("session.transcript.replaced");
    });
  });

  it("admits prompts, creates messages, updates parts, and keeps per-session order", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "s2", cwd: process.cwd(), model: "m" });

      const prompt = store.admitPrompt({ id: "i1", sessionId: "s1", content: "hello from the first prompt sentence." });
      expect(store.getSession("s1")?.title).toBe("hello from the first");
      expect(store.resolveSessionListTitle("s1")).toBe("hello from the first");
      const first = store.createMessage({ id: "m1", sessionId: "s1", role: "user", inputId: prompt.id });
      const userPart = store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: first.id,
        type: "text",
        status: "completed",
        text: "hello",
      });
      const second = store.createMessage({ id: "m2", sessionId: "s1", role: "assistant" });
      const assistantPart = store.upsertMessagePart({
        id: "p2",
        sessionId: "s1",
        messageId: second.id,
        type: "text",
        status: "running",
        text: "h",
      });
      const deltaEvent = store.appendMessagePartDelta({
        sessionId: "s1",
        messageId: second.id,
        partId: assistantPart.id,
        field: "text",
        delta: "i",
      });
      expect(store.latestEventSeq()).toBe(deltaEvent.seq);
      expect(prompt.seq).toBe(1);
      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
      expect(userPart.seq).toBe(1);
      expect(store.listMessages("s1").map((row) => row.id)).toEqual(["m1", "m2"]);
      expect(store.listMessages("s1", { afterSeq: 1 }).map((row) => row.id)).toEqual(["m2"]);
      expect(store.listMessageParts("s1").map((row) => [row.id, row.text])).toEqual([
        ["p1", "hello"],
        ["p2", "hi"],
      ]);
      expect(store.listMessageParts("s1", { messageId: second.id }).map((row) => row.id)).toEqual(["p2"]);
      expect(store.listEvents().map((event) => event.type)).not.toContain("session.message.part.delta");
      const runningReloaded = new SessionStore({ path });
      expect(runningReloaded.listMessageParts("s1", { messageId: second.id })).toMatchObject([
        { id: "p2", text: "h", status: "running" },
      ]);
      runningReloaded.close();
      store.flushMessagePartDeltas();
      const checkpointReloaded = new SessionStore({ path });
      expect(checkpointReloaded.listMessageParts("s1", { messageId: second.id })).toMatchObject([
        { id: "p2", text: "hi", status: "running" },
      ]);
      checkpointReloaded.close();
      store.createMessage({ id: "m3", sessionId: "s2", role: "user" });
      store.upsertMessagePart({
        id: "p2",
        sessionId: "s1",
        messageId: second.id,
        type: "text",
        status: "completed",
      });

      const reloaded = new SessionStore({ path });
      expect(reloaded.listMessageParts("s1", { messageId: second.id }).map((row) => [row.id, row.text])).toEqual([
        ["p2", "hi"],
      ]);
      expect(reloaded.listEvents().map((event) => event.type)).not.toContain("session.message.part.delta");
      expect(reloaded.listEvents().map((event) => event.type)).toContain("session.message.part.updated");
      reloaded.close();
    });
  });

  it("replays monotonic events by cursor and session", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const cursor = store.listEvents().at(-1)!.seq;
      store.createSession({ id: "s2", cwd: process.cwd(), model: "m" });
      store.admitPrompt({ sessionId: "s1", content: "wake" });
      store.appendEvent({ type: "daemon.heartbeat", payload: { ok: true } });

      expect(store.listEvents().map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(store.listEvents({ afterSeq: cursor }).map((event) => event.type)).toEqual([
        "session.created",
        "session.input.admitted",
        "daemon.heartbeat",
      ]);
      expect(store.listEvents({ afterSeq: cursor, sessionId: "s1" }).map((event) => event.type)).toEqual([
        "session.input.admitted",
        "daemon.heartbeat",
      ]);
    });
  });

  it("keeps runs terminal while allowing a child task to bind a later run", () => {
    withStore((store) => {
      store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "child", parentId: "parent", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({ id: "i1", sessionId: "child", content: "first" });
      const run = store.createRun({ id: "r1", sessionId: "child", inputId: input.id });
      store.updateRun(run.id, { status: "failed", error: "first failed" });
      expect(() => store.updateRun(run.id, { status: "running" })).toThrow("Session run is already terminal");
      expect(store.getRun(run.id)).toMatchObject({ status: "failed", error: "first failed" });

      const nextInput = store.admitPrompt({ id: "i2", sessionId: "child", content: "second" });
      const nextRun = store.createRun({ id: "r2", sessionId: "child", inputId: nextInput.id });

      store.createSessionTask({
        id: "task-1",
        sessionId: "parent",
        childSessionId: "child",
        runId: nextRun.id,
        type: "agent",
        description: "Explore",
        cwd: process.cwd(),
      });
      store.updateSessionTask("task-1", { status: "failed", output: "old", error: "old error" });
      store.updateSessionTask("task-1", { status: "running" });
      expect(store.getSessionTask("task-1")).toMatchObject({ status: "running" });
      expect(store.getSessionTask("task-1")).not.toHaveProperty("finishedAt");
      expect(store.getSessionTask("task-1")).not.toHaveProperty("output");
      expect(store.getSessionTask("task-1")).not.toHaveProperty("error");
    }, { deltaFlushIntervalMs: 60_000, deltaFlushBytes: 1024 * 1024 });
  });

  it("flushes pending text deltas when the store closes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-close-"));
    const path = join(dir, "store.db");
    const store = new SessionStore({ path, deltaFlushIntervalMs: 60_000, deltaFlushBytes: 1024 * 1024 });
    store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
    const message = store.createMessage({ id: "m1", sessionId: "s1", role: "assistant" });
    const part = store.upsertMessagePart({
      id: "p1",
      sessionId: "s1",
      messageId: message.id,
      type: "text",
      status: "running",
      text: "",
    });
    store.appendMessagePartDelta({
      sessionId: "s1",
      messageId: message.id,
      partId: part.id,
      field: "text",
      delta: "checkpointed",
    });

    store.close();
    const reloaded = new SessionStore({ path });
    expect(reloaded.listMessageParts("s1")).toMatchObject([{ id: "p1", text: "checkpointed" }]);
    reloaded.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("checkpoints high-frequency deltas in one write transaction", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({ id: "m1", sessionId: "s1", role: "assistant" });
      const part = store.upsertMessagePart({
        id: "p1", sessionId: "s1", messageId: message.id, type: "text", status: "running", text: "",
      });
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TABLE delta_audit (count INTEGER NOT NULL);
        INSERT INTO delta_audit VALUES (0);
        CREATE TRIGGER count_delta_update AFTER UPDATE OF text ON session_message_part
        WHEN NEW.id = 'p1'
        BEGIN
          UPDATE delta_audit SET count = count + 1;
        END;
      `);

      for (let index = 0; index < 100; index++) {
        store.appendMessagePartDelta({
          sessionId: "s1", messageId: message.id, partId: part.id, field: "text", delta: "x",
        });
      }
      expect(database.prepare("SELECT text FROM session_message_part WHERE id = 'p1'").get())
        .toEqual({ text: "" });

      store.flushMessagePartDeltas();

      expect(database.prepare("SELECT count FROM delta_audit").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT length(text) AS length FROM session_message_part WHERE id = 'p1'").get())
        .toEqual({ length: 100 });
    }, { deltaFlushIntervalMs: 60_000, deltaFlushBytes: 1024 * 1024 });
  });

  it("flushes grouped deltas on the timer and retries a failed checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-timer-"));
    const path = join(dir, "store.db");
    const store = new SessionStore({ path, deltaFlushIntervalMs: 10, deltaFlushBytes: 1024 * 1024 });
    try {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({ id: "m1", sessionId: "s1", role: "assistant" });
      const part = store.upsertMessagePart({
        id: "p1", sessionId: "s1", messageId: message.id, type: "text", status: "running", text: "",
      });
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TRIGGER fail_delta_update BEFORE UPDATE OF text ON session_message_part
        WHEN NEW.id = 'p1'
        BEGIN
          SELECT RAISE(ABORT, 'forced delta failure');
        END;
      `);
      store.transaction(() => {
        store.appendMessagePartDelta({
          sessionId: "s1", messageId: message.id, partId: part.id, field: "text", delta: "timer",
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(database.prepare("SELECT text FROM session_message_part WHERE id = 'p1'").get())
        .toEqual({ text: "" });
      database.exec("DROP TRIGGER fail_delta_update");

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(database.prepare("SELECT text FROM session_message_part WHERE id = 'p1'").get())
        .toEqual({ text: "timer" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushes immediately when the delta byte threshold is reached", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({ id: "m1", sessionId: "s1", role: "assistant" });
      const part = store.upsertMessagePart({
        id: "p1", sessionId: "s1", messageId: message.id, type: "text", status: "running", text: "",
      });
      const database = (store as any).database as Database.Database;
      store.appendMessagePartDelta({
        sessionId: "s1", messageId: message.id, partId: part.id, field: "text", delta: "he",
      });
      expect(database.prepare("SELECT text FROM session_message_part WHERE id = 'p1'").get())
        .toEqual({ text: "" });
      store.appendMessagePartDelta({
        sessionId: "s1", messageId: message.id, partId: part.id, field: "text", delta: "llo",
      });
      expect(database.prepare("SELECT text FROM session_message_part WHERE id = 'p1'").get())
        .toEqual({ text: "hello" });
    }, { deltaFlushIntervalMs: 60_000, deltaFlushBytes: 5 });
  });

  it("rolls back both SQLite and the in-memory read model when a grouped write fails", () => {
    withStore((store, path) => {
      store.createSession({ id: "existing", cwd: process.cwd(), model: "m" });

      expect(() => store.transaction(() => {
        store.createSession({ id: "transient", cwd: process.cwd(), model: "m" });
        (store as any).database.exec(`
          CREATE TRIGGER fail_session_insert
          BEFORE INSERT ON session
          BEGIN
            SELECT RAISE(ABORT, 'forced store failure');
          END;
        `);
        store.createSession({ id: "never-committed", cwd: process.cwd(), model: "m" });
      })).toThrow("forced store failure");

      expect(store.getSession("existing")).toBeDefined();
      expect(store.getSession("transient")).toBeUndefined();
      expect(store.getSession("never-committed")).toBeUndefined();

      const reloaded = new SessionStore({ path });
      expect(reloaded.listSessions().map((session) => session.id)).toEqual(["existing"]);
      reloaded.close();
    });
  });

  it("does not reuse a live delta sequence after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-sequence-"));
    const path = join(dir, "store.db");
    try {
      const store = new SessionStore({ path, deltaFlushIntervalMs: 60_000 });
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const message = store.createMessage({ id: "m1", sessionId: "s1", role: "assistant" });
      const part = store.upsertMessagePart({
        id: "p1",
        sessionId: "s1",
        messageId: message.id,
        type: "text",
        status: "running",
        text: "",
      });
      const delta = store.appendMessagePartDelta({
        sessionId: "s1",
        messageId: message.id,
        partId: part.id,
        field: "text",
        delta: "live",
      });
      store.close();

      const reloaded = new SessionStore({ path });
      const durable = reloaded.appendEvent({ type: "daemon.after-restart", sessionId: "s1" });
      expect(durable.seq).toBeGreaterThan(delta.seq);
      expect(reloaded.listEvents({ afterSeq: delta.seq }).map((event) => event.id)).toContain(durable.id);
      reloaded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists only dirty rows and commits grouped mutations once", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "s2", cwd: process.cwd(), model: "m" });
      const database = (store as any).database as Database.Database;
      database.exec(`
        CREATE TABLE mutation_audit (count INTEGER NOT NULL);
        INSERT INTO mutation_audit VALUES (0);
        CREATE TRIGGER reject_session_delete BEFORE DELETE ON session
        BEGIN
          SELECT RAISE(ABORT, 'full snapshot rewrite detected');
        END;
        CREATE TRIGGER count_s1_update AFTER UPDATE ON session
        WHEN NEW.id = 's1'
        BEGIN
          UPDATE mutation_audit SET count = count + 1;
        END;
      `);

      store.transaction(() => {
        store.updateSession("s1", { title: "first" });
        store.updateSession("s1", { title: "final" });
      });

      expect(database.prepare("SELECT count FROM mutation_audit").get()).toEqual({ count: 1 });
      const reloaded = new SessionStore({ path });
      expect(reloaded.getSession("s1")?.title).toBe("final");
      expect(reloaded.getSession("s2")).toBeDefined();
      reloaded.close();
    });
  });

  it("tracks runs and permission replies as durable events", () => {
    withStore((store, path) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({ id: "i1", sessionId: "s1", content: "edit file" });
      const run = store.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
      store.updateRun(run.id, { status: "running" });
      const message = store.createMessage({ id: "m1", sessionId: "s1", role: "assistant", runId: run.id });
      store.upsertMessagePart({
        id: "part-tool",
        sessionId: "s1",
        messageId: message.id,
        type: "tool",
        status: "running",
        toolUseId: "tu1",
        toolName: "Write",
        input: { path: "README.md" },
      });
      store.upsertMessagePart({
        id: "part-tool",
        sessionId: "s1",
        messageId: message.id,
        type: "tool",
        status: "completed",
        toolUseId: "tu1",
        toolName: "Write",
        input: { path: "README.md" },
        output: { content: [{ type: "text", text: "ok" }] },
      });
      const permission = store.createPermissionRequest({
        id: "p1",
        sessionId: "s1",
        runId: run.id,
        toolName: "shell",
        payload: { command: "pnpm test" },
      });
      store.replyPermission({
        requestId: permission.id,
        status: "approved",
        decision: "once",
        clientId: "tui-1",
      });
      expect(() => store.replyPermission({ requestId: permission.id, status: "denied" }))
        .toThrow("Permission request already resolved");
      store.updateRun(run.id, { status: "completed" });

      const reloaded = new SessionStore({ path });
      expect(reloaded.getRun("r1")!.status).toBe("completed");
      expect(reloaded.listMessageParts("s1")).toMatchObject([
        {
          id: "part-tool",
          status: "completed",
          toolName: "Write",
          output: { content: [{ type: "text", text: "ok" }] },
        },
      ]);
      expect(reloaded.getPermissionRequest("p1")).toMatchObject({
        status: "approved",
        decision: "once",
        decidedByClientId: "tui-1",
      });
      expect(reloaded.listPermissionRequests({ sessionId: "s1", status: "approved" })).toMatchObject([
        { id: "p1", toolName: "shell" },
      ]);
      expect(reloaded.listEvents().map((event) => event.type)).toContain("permission.replied");
      expect(reloaded.listEvents().map((event) => event.type)).toContain("session.message.part.updated");
      reloaded.close();
    });
  });

  it("returns an atomic attach snapshot and interrupts runs left by a previous daemon", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({ id: "i1", sessionId: "s1", content: "hello" });
      store.createRun({ id: "r1", sessionId: "s1", inputId: input.id });
      const message = store.createMessage({ id: "m1", sessionId: "s1", role: "user", inputId: input.id });
      store.upsertMessagePart({
        id: "part1", sessionId: "s1", messageId: message.id, type: "text", status: "completed", text: "hello",
      });
      const assistant = store.createMessage({ id: "m2", sessionId: "s1", role: "assistant", runId: "r1" });
      store.upsertMessagePart({
        id: "part-running-text",
        sessionId: "s1",
        messageId: assistant.id,
        type: "text",
        status: "running",
        text: "partial",
      });
      store.upsertMessagePart({
        id: "part-running-tool",
        sessionId: "s1",
        messageId: assistant.id,
        type: "tool",
        status: "running",
        toolUseId: "tool-1",
        toolName: "Read",
      });

      expect(store.interruptActiveRuns()).toBe(1);
      const snapshot = store.getSessionState("s1");
      expect(snapshot.cursor).toBe(store.listEvents().at(-1)?.seq);
      expect(snapshot.inputs.map((row) => row.id)).toEqual(["i1"]);
      expect(snapshot.messages.map((row) => row.id)).toEqual(["m1", "m2"]);
      expect(snapshot.parts.find((row) => row.id === "part1")?.text).toBe("hello");
      expect(snapshot.runs).toMatchObject([{ id: "r1", status: "interrupted" }]);
      expect(snapshot.parts.filter((part) => part.messageId === "m2").map((part) => part.status))
        .toEqual(["interrupted", "interrupted"]);
    });
  });

  it("expires permission requests whose live resolver belonged to a previous daemon", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.createPermissionRequest({ id: "pending", sessionId: "s1", toolName: "Write" });
      const resolved = store.createPermissionRequest({ id: "resolved", sessionId: "s1", toolName: "Read" });
      store.replyPermission({ requestId: resolved.id, status: "approved", decision: "once" });

      expect(store.expirePendingPermissionRequests()).toBe(1);
      expect(store.getPermissionRequest("pending")).toMatchObject({
        status: "expired",
        decision: "Daemon restarted before the permission was resolved",
      });
      expect(store.getPermissionRequest("resolved")?.status).toBe("approved");
    });
  });

  it("persists task/child/run links and terminalizes active tasks after a restart", () => {
    withStore((store, path) => {
      store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "child", parentId: "parent", cwd: process.cwd(), model: "m" });
      const input = store.admitPrompt({ id: "child-input", sessionId: "child", content: "inspect" });
      const run = store.createRun({ id: "child-run", sessionId: "child", inputId: input.id });
      store.createSessionTask({
        id: "task-child",
        sessionId: "parent",
        childSessionId: "child",
        type: "agent",
        description: "Explore@default",
        cwd: process.cwd(),
      });
      store.updateSessionTask("task-child", { runId: run.id });

      const reloaded = new SessionStore({ path });
      expect(reloaded.getSessionState("parent").tasks).toMatchObject([{
        id: "task-child",
        childSessionId: "child",
        runId: "child-run",
        status: "running",
      }]);
      expect(reloaded.interruptActiveSessionTasks()).toBe(1);
      expect(reloaded.getSessionTask("task-child")).toMatchObject({
        status: "interrupted",
        error: "Daemon restarted before the task completed",
      });
      expect(reloaded.listEvents({ sessionId: "parent" }).map((event) => event.type)).toContain("session.task.updated");
      reloaded.close();
    });
  });

  it("archives sessions without deleting their replay history", () => {
    withStore((store) => {
      store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      store.archiveSession("s1");

      expect(store.listSessions().map((session) => session.id)).toEqual([]);
      expect(store.listSessions({ includeArchived: true }).map((session) => session.id)).toEqual(["s1"]);
      expect(store.listEvents().map((event) => event.type)).toEqual(["session.created", "session.archived"]);
    });
  });
});
