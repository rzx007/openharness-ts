import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "./store.js";

function withStore(test: (store: SessionStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ohs-session-runtime-"));
  const path = join(dir, "store.json");
  try {
    test(new SessionStore({ path }), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SessionStore", () => {
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
    });
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
    withStore((store) => {
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
      store.appendMessagePartDelta({
        sessionId: "s1",
        messageId: second.id,
        partId: assistantPart.id,
        field: "text",
        delta: "i",
      });
      store.createMessage({ id: "m3", sessionId: "s2", role: "user" });

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

      expect(store.interruptActiveRuns()).toBe(1);
      const snapshot = store.getSessionState("s1");
      expect(snapshot.cursor).toBe(store.listEvents().at(-1)?.seq);
      expect(snapshot.inputs.map((row) => row.id)).toEqual(["i1"]);
      expect(snapshot.messages.map((row) => row.id)).toEqual(["m1"]);
      expect(snapshot.parts.map((row) => row.text)).toEqual(["hello"]);
      expect(snapshot.runs).toMatchObject([{ id: "r1", status: "interrupted" }]);
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
