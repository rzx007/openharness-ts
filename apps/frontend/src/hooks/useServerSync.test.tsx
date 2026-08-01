import { afterEach, expect, test } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { useServerSync } from "./useServerSync";
import type { TuiSessionController } from "./sessionController";
import type { SessionEventRecord, SessionMessagePartRecord, SessionMessageRecord, SessionRecord } from "@openharness/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function event(seq: number, type: string, payload: Record<string, unknown>, sessionId = "s1"): SessionEventRecord {
  return { id: `e${seq}`, seq, type, sessionId, payload, createdAt: seq };
}

function sseResponse(events: SessionEventRecord[] = []): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const item of events) {
        controller.enqueue(encoder.encode(
          `id: ${item.seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`,
        ));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("useServerSync hydrates daemon state and sends prompt/permission replies", async () => {
  const session: SessionRecord = {
    id: "s1",
    cwd: process.cwd(),
    title: "TUI",
    model: "m",
    status: "idle",
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  };
  const createdSession: SessionRecord = {
    ...session,
    id: "s2",
    title: "Scratch",
    createdAt: 4,
    updatedAt: 4,
  };
  const message: SessionMessageRecord = {
    id: "m1",
    sessionId: "s1",
    seq: 1,
    role: "assistant",
    metadata: {},
    createdAt: 2,
    updatedAt: 2,
  };
  const textPart: SessionMessagePartRecord = {
    id: "p1",
    sessionId: "s1",
    messageId: "m1",
    seq: 1,
    type: "text",
    status: "completed",
    text: "hello from daemon",
    metadata: {},
    createdAt: 2.5,
    updatedAt: 2.5,
  };
  const toolPart: SessionMessagePartRecord = {
    id: "hist1",
    sessionId: "s1",
    messageId: "m1",
    seq: 2,
    type: "tool",
    status: "completed",
    toolUseId: "hist1",
    toolName: "Read",
    input: { path: "README.md" },
    output: { content: [{ type: "text", text: "historical output" }] },
    metadata: {},
    createdAt: 2.6,
    updatedAt: 2.6,
  };
  const liveMessage: SessionMessageRecord = {
    id: "m-live",
    sessionId: "s1",
    seq: 2,
    role: "assistant",
    metadata: {},
    createdAt: 5,
    updatedAt: 5,
  };
  const liveTextPart: SessionMessagePartRecord = {
    id: "p-live",
    sessionId: "s1",
    messageId: "m-live",
    seq: 3,
    type: "text",
    status: "running",
    text: "",
    metadata: {},
    createdAt: 6,
    updatedAt: 6,
  };
  const liveToolPart: SessionMessagePartRecord = {
    id: "live1",
    sessionId: "s1",
    messageId: "m-live",
    seq: 4,
    type: "tool",
    status: "completed",
    toolUseId: "live1",
    toolName: "Bash",
    input: { command: "pwd" },
    output: { content: [{ type: "text", text: "live output" }] },
    metadata: {},
    createdAt: 7,
    updatedAt: 8,
  };
  const permission = {
    id: "p1",
    sessionId: "s1",
    runId: "r1",
    toolName: "Write",
    payload: { reason: "needs edit", input: { path: "README.md" } },
    status: "pending",
    createdAt: 3,
    updatedAt: 3,
  };
  const run = {
    id: "r1",
    sessionId: "s1",
    inputId: "i1",
    status: "running",
    metadata: {},
    createdAt: 4,
    updatedAt: 4,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/health") {
      return jsonResponse({ ok: true });
    }
    if (pathname === "/sessions" && init?.method === "POST") return jsonResponse({ session: createdSession });
    if (pathname === "/sessions") return jsonResponse({ sessions: [session] });
    if (pathname === "/sessions/s1/state") {
      return jsonResponse({
        cursor: 6,
        session,
        inputs: [],
        messages: [message],
        parts: [textPart, toolPart],
        runs: [run],
        permissions: [permission],
      });
    }
    if (pathname === "/sessions/s2/state") {
      return jsonResponse({
        cursor: 10,
        session: createdSession,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        permissions: [],
      });
    }
    if (pathname === "/sessions/s2" && init?.method === "DELETE") {
      return jsonResponse({ session: { ...createdSession, status: "archived" } });
    }
    if (pathname === "/events") {
      return jsonResponse({
        events: [
          event(1, "session.created", { session }),
          event(2, "session.message.created", { message }),
          event(3, "session.message.part.updated", { part: textPart }),
          event(4, "session.message.part.updated", { part: toolPart }),
          event(5, "permission.asked", { request: permission }),
          event(6, "session.run.updated", { run }),
          event(7, "session.message.created", { message: liveMessage }),
          event(8, "session.message.part.updated", { part: liveTextPart }),
          event(9, "session.message.part.delta", {
            sessionId: "s1",
            messageId: "m-live",
            partId: "p-live",
            field: "text",
            delta: "streaming now",
          }),
          event(10, "session.message.part.updated", { part: liveToolPart }),
        ],
      });
    }
    if (pathname === "/events/stream") return sseResponse([
      event(7, "session.message.created", { message: liveMessage }),
      event(8, "session.message.part.updated", { part: liveTextPart }),
      event(9, "session.message.part.delta", {
        sessionId: "s1",
        messageId: "m-live",
        partId: "p-live",
        field: "text",
        delta: "streaming now",
      }),
      event(10, "session.message.part.updated", { part: liveToolPart }),
    ]);
    if (pathname === "/sessions/s1/prompts") return jsonResponse({ input: { id: "i1" } });
    if (pathname === "/permissions/p1/reply") {
      return jsonResponse({ request: { ...permission, status: "approved", decision: "once" } });
    }
    return jsonResponse({});
  }) as typeof fetch;

  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: { url: "http://daemon.test", token: "tok", cwd: session.cwd, model: "m" },
    }, () => {});
    return <box />;
  }

  const { renderer, renderOnce } = await testRender(<Harness />, { width: 80, height: 24 });
  for (let i = 0; i < 20 && (!captured?.ready || captured.transcript.length === 0 || !captured.modal); i += 1) {
    await act(async () => {
      await renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  expect(captured?.ready).toBe(true);
  expect(captured?.transcript.map((item) => item.text)).toContain("hello from daemon");
  expect(captured?.transcript).toContainEqual(expect.objectContaining({
    role: "tool",
    tool_name: "Read",
    tool_input: { path: "README.md" },
  }));
  expect(captured?.transcript).toContainEqual(expect.objectContaining({
    role: "tool_result",
    tool_name: "Read",
    text: "historical output",
  }));
  expect(captured?.transcript).toContainEqual(expect.objectContaining({
    role: "tool",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  }));
  expect(captured?.transcript).toContainEqual(expect.objectContaining({
    role: "tool_result",
    tool_name: "Bash",
    text: "live output",
  }));
  expect(captured?.transcript.map((item) => item.text)).toContain("streaming now");
  expect(captured?.assistantBuffer).toBe("");
  expect(captured?.modal).toMatchObject({ kind: "permission", request_id: "p1", tool_name: "Write" });

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "next prompt" });
    captured?.sendRequest({ type: "permission_response", request_id: "p1", allowed: true, scope: "once" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s1/prompts")).toBe(true);
  expect(calls.some((call) => call.url === "http://daemon.test/permissions/p1/reply")).toBe(true);
  expect(calls.every((call) => (call.init.headers as Record<string, string> | undefined)?.authorization === "Bearer tok")).toBe(true);

  await act(async () => {
    captured?.sendRequest({ type: "list_sessions" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.selectRequest?.options[0]).toMatchObject({
    value: "__openharness_new_session__",
    label: "New session",
  });

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/new Scratch" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST")).toBe(true);
  expect(captured?.status.session_id).toBe("s2");
  expect(captured?.busy).toBe(false);

  await act(async () => {
    captured?.sendRequest({ type: "delete_session", session_id: "s2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s2" && call.init.method === "DELETE")).toBe(true);
  expect(captured?.status.session_id).toBe("s1");

  renderer.destroy();
});
