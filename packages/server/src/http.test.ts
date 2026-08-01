import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OpenHarnessHttpServer } from "./http.js";
import { getDefaultSessionStorePath } from "./paths.js";
import type { SessionRuntimeFactory } from "./runtime.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withServer(
  test: (ctx: { baseUrl: string; token: string; storePath: string }) => Promise<void>,
  options: { runtimeFactory?: SessionRuntimeFactory } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohs-server-"));
  const token = "test-token";
  const server = new OpenHarnessHttpServer({
    token,
    storePath: join(dir, "sessions.json"),
    runtimeFactory: options.runtimeFactory,
  });
  const listen = await server.listen();
  try {
    await test({ baseUrl: listen.url, token, storePath: join(dir, "sessions.json") });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function waitForEvent(
  baseUrl: string,
  token: string,
  predicate: (event: { type: string; payload?: Record<string, unknown> }) => boolean,
): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
  for (let i = 0; i < 50; i++) {
    const body = await (await fetch(`${baseUrl}/events`, { headers: auth(token) })).json() as {
      events: Array<{ type: string; payload?: Record<string, unknown> }>;
    };
    if (body.events.some(predicate)) return body.events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for event");
}

describe("OpenHarnessHttpServer", () => {
  it("uses the canonical session runtime store", () => {
    expect(getDefaultSessionStorePath()).toMatch(/[\\/]session-runtime[\\/]sessions\.json$/);
  });

  it("serves health and protects routes with bearer auth", async () => {
    await withServer(async ({ baseUrl, token }) => {
      expect((await fetch(`${baseUrl}/health`)).status).toBe(401);
      const response = await fetch(`${baseUrl}/health`, { headers: auth(token) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
      });
    });
  });

  it("creates sessions, admits prompts, and replays events by cursor", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const created = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m", title: "Main" }),
      });
      expect(created.status).toBe(201);

      const firstEvents = await (await fetch(`${baseUrl}/events`, { headers: auth(token) })).json() as {
        events: Array<{ seq: number; type: string }>;
      };
      expect(firstEvents.events.map((event) => event.type)).toEqual(["session.created"]);
      const cursor = firstEvents.events[0]!.seq;

      const prompt = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "hello", delivery: "queue" }),
      });
      expect(prompt.status).toBe(202);

      const sessions = await (await fetch(`${baseUrl}/sessions`, { headers: auth(token) })).json() as {
        sessions: Array<{ id: string }>;
      };
      expect(sessions.sessions.map((session) => session.id)).toEqual(["s1"]);

      const nextEvents = await (await fetch(`${baseUrl}/events?cursor=${cursor}`, { headers: auth(token) })).json() as {
        events: Array<{ type: string }>;
      };
      expect(nextEvents.events.map((event) => event.type)).toEqual(["session.input.admitted"]);

      const snapshot = await (await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })).json() as {
        cursor: number;
        inputs: Array<{ content: string }>;
        messages: unknown[];
        parts: unknown[];
      };
      expect(snapshot.cursor).toBeGreaterThan(cursor);
      expect(snapshot.inputs.map((input) => input.content)).toEqual(["hello"]);
      expect(snapshot.messages).toEqual([]);
      expect(snapshot.parts).toEqual([]);
    });
  });

  it("archives sessions via DELETE and hides them from the default list", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m", title: "Main" }),
      });

      const archived = await fetch(`${baseUrl}/sessions/s1`, {
        method: "DELETE",
        headers: auth(token),
      });
      expect(archived.status).toBe(200);
      expect((await archived.json() as { session: { status: string } }).session.status).toBe("archived");

      const listed = await (await fetch(`${baseUrl}/sessions`, { headers: auth(token) })).json() as {
        sessions: Array<{ id: string }>;
      };
      expect(listed.sessions).toEqual([]);

      const events = await (await fetch(`${baseUrl}/events`, { headers: auth(token) })).json() as {
        events: Array<{ type: string }>;
      };
      expect(events.events.map((event) => event.type)).toContain("session.archived");
    });
  });

  it("streams replayed and live events over SSE", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });

      const abort = new AbortController();
      const stream = await fetch(`${baseUrl}/events/stream?cursor=0`, {
        headers: auth(token),
        signal: abort.signal,
      });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";

      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "wake" }),
      });

      for (let i = 0; i < 20 && !text.includes("session.input.admitted"); i++) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      abort.abort();

      expect(text).toContain("session.created");
      expect(text).toContain("session.input.admitted");
    });
  });

  it("runs admitted prompts through an injected session runtime", async () => {
    const closed: string[] = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime({ session }) {
        return {
          async runPrompt(input, hooks) {
            expect(input.session.id).toBe(session.id);
            expect(input.input.content).toBe("hello runtime");
            expect(input.history).toEqual([]);
            expect(input.parts).toEqual([]);
            await hooks.onStreamEvent({ type: "text_delta", delta: "hello" });
            return {
              messages: [],
            };
          },
          async close() {
            closed.push(session.id);
          },
        };
      },
    };

    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });

      const prompt = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "hello runtime" }),
      });
      expect(prompt.status).toBe(202);
      const body = await prompt.json() as { run?: { status: string } };
      expect(body.run?.status).toBe("pending");

      const events = await waitForEvent(
        baseUrl,
        token,
        (event) =>
          event.type === "session.run.updated" &&
          (event.payload?.run as { status?: string } | undefined)?.status === "completed",
      );
      expect(events.map((event) => event.type)).toContain("session.message.part.delta");

      const messages = await (await fetch(`${baseUrl}/sessions/s1/messages`, { headers: auth(token) })).json() as {
        messages: Array<{ role: string; inputId?: string }>;
      };
      const parts = await (await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })).json() as {
        parts: Array<{ type: string; text?: string; status: string }>;
      };
      expect(messages.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages.messages[0]).toMatchObject({ inputId: expect.any(String) });
      expect(parts.parts.map((part) => [part.type, part.text])).toEqual([
        ["text", "hello runtime"],
        ["text", "hello"],
      ]);
      expect(closed).toEqual([]);
    }, { runtimeFactory });
    expect(closed).toEqual(["s1"]);
  });

  it("persists each model turn as a separate assistant message", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(_input, hooks) {
            await hooks.onStreamEvent({ type: "text_delta", delta: "checking" });
            await hooks.onStreamEvent({
              type: "tool_use_start",
              toolUse: { type: "tool_use", id: "tool-1", name: "Read", input: { path: "README.md" } },
            });
            await hooks.onStreamEvent({ type: "complete", stopReason: "tool_use" });
            await hooks.onStreamEvent({
              type: "tool_use_end",
              toolUseId: "tool-1",
              result: { content: [{ type: "text", text: "file contents" }] },
            });
            await hooks.onStreamEvent({ type: "text_delta", delta: "finished" });
            await hooks.onStreamEvent({ type: "complete", stopReason: "end_turn" });
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "inspect" }),
      });
      await waitForEvent(
        baseUrl,
        token,
        (event) => event.type === "session.run.updated" &&
          (event.payload?.run as { status?: string } | undefined)?.status === "completed",
      );

      const messages = await (await fetch(`${baseUrl}/sessions/s1/messages`, { headers: auth(token) })).json() as {
        messages: Array<{ id: string; role: string }>;
      };
      const parts = await (await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })).json() as {
        parts: Array<{ messageId: string; type: string; text?: string; toolName?: string }>;
      };
      expect(messages.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
      const assistantIds = messages.messages.filter((message) => message.role === "assistant").map((message) => message.id);
      expect(assistantIds[0]).not.toBe(assistantIds[1]);
      expect(parts.parts).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageId: assistantIds[0], type: "tool", toolName: "Read" }),
        expect.objectContaining({ messageId: assistantIds[1], type: "text", text: "finished" }),
      ]));
    }, { runtimeFactory });
  });

  it("queues prompts for the same session and persists messages in run order", async () => {
    const releaseFirst = deferred();
    const started: string[] = [];
    let created = 0;
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        created += 1;
        return {
          async runPrompt(input) {
            started.push(input.input.content);
            if (input.input.content === "first") await releaseFirst.promise;
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });

      const first = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "first" }),
      });
      expect((await first.json() as { queue_state?: string }).queue_state).toBe("running");

      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "running",
      );

      const second = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "second" }),
      });
      expect((await second.json() as { queue_state?: string }).queue_state).toBe("queued");
      expect(started).toEqual(["first"]);

      releaseFirst.resolve();
      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "completed" &&
        started.includes("second"),
      );

      const messages = await (await fetch(`${baseUrl}/sessions/s1/messages`, { headers: auth(token) })).json() as {
        messages: Array<{ role: string }>;
      };
      const parts = await (await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })).json() as {
        parts: Array<{ text?: string }>;
      };
      expect(messages.messages.map((message) => message.role)).toEqual(["user", "user"]);
      expect(parts.parts.map((part) => part.text)).toEqual(["first", "second"]);
      expect(created).toBe(1);
    }, { runtimeFactory });
  });

  it("keeps permission requests alive after an event client disconnects and accepts a later reply", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input, hooks) {
            const allowed = await hooks.askPermission({
              toolName: "Write",
              reason: "needs edit",
              input: { path: "README.md" },
            });
            await hooks.onStreamEvent({
              type: "text_delta",
              delta: allowed ? "permission granted" : "permission denied",
            });
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });

      const abort = new AbortController();
      const stream = await fetch(`${baseUrl}/events/stream?sessionId=s1`, {
        headers: auth(token),
        signal: abort.signal,
      });
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();

      const prompt = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "please edit" }),
      });
      expect(prompt.status).toBe(202);

      let streamText = "";
      for (let i = 0; i < 50 && !streamText.includes("permission.asked"); i++) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamText += decoder.decode(chunk.value, { stream: true });
      }
      expect(streamText).toContain("permission.asked");
      await reader.cancel();
      abort.abort();

      const pending = await (await fetch(`${baseUrl}/permissions?sessionId=s1&status=pending`, {
        headers: auth(token),
      })).json() as { requests: Array<{ id: string; status: string; toolName: string }> };
      expect(pending.requests).toMatchObject([{ status: "pending", toolName: "Write" }]);

      const replied = await fetch(`${baseUrl}/permissions/${pending.requests[0]!.id}/reply`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ status: "approved", decision: "session", clientId: "web-2" }),
      });
      expect(replied.status).toBe(200);

      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "completed",
      );

      const messages = await (await fetch(`${baseUrl}/sessions/s1/messages`, { headers: auth(token) })).json() as {
        messages: Array<{ role: string }>;
      };
      const parts = await (await fetch(`${baseUrl}/sessions/s1/parts`, { headers: auth(token) })).json() as {
        parts: Array<{ text?: string }>;
      };
      expect(messages.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(parts.parts.map((part) => part.text)).toEqual(["please edit", "permission granted"]);
    }, { runtimeFactory });
  });

  it("interrupts active and queued session runs", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("interrupted by test");
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "active" }),
      });
      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "running",
      );
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "queued" }),
      });

      const interrupted = await fetch(`${baseUrl}/sessions/s1/interrupt`, {
        method: "POST",
        headers: auth(token),
      });
      expect(await interrupted.json()).toMatchObject({
        activeRunId: expect.any(String),
        queuedRunIds: [expect.any(String)],
        interrupted: true,
      });

      const events = await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "interrupted",
      );
      expect(events.map((event) => event.type)).toContain("session.run.interrupt_requested");
    }, { runtimeFactory });
  });
});
