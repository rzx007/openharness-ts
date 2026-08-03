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
  const childSession: SessionRecord = {
    ...session,
    id: "child1",
    parentId: "s1",
    title: "Child worker",
    status: "running",
    createdAt: 3,
    updatedAt: 6,
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
  const interruptedInput = {
    id: "i-interrupted",
    sessionId: "s1",
    seq: 2,
    delivery: "queue" as const,
    content: "finish interrupted work",
    metadata: {},
    createdAt: 5,
  };
  const interruptedRun = {
    id: "r-interrupted",
    sessionId: "s1",
    inputId: interruptedInput.id,
    status: "interrupted" as const,
    error: "Daemon restarted before the run completed",
    metadata: {},
    createdAt: 5,
    updatedAt: 5,
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let holdNextSessionList = false;
  let releaseHeldSessionList: ((response: Response) => void) | undefined;
  let holdNextContext = false;
  let releaseHeldContext: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/health") {
      return jsonResponse({ ok: true });
    }
    if (pathname === "/commands") {
      return jsonResponse({
        commands: [
          { name: "/model", kind: "session", source: "builtin", description: "Show or switch the session model" },
          { name: "/skills", kind: "session", source: "builtin", description: "List skills" },
          { name: "/config", kind: "session", source: "builtin", description: "Show or edit settings" },
          { name: "/provider", kind: "session", source: "builtin", description: "Show or switch provider" },
          { name: "/mcp", kind: "session", source: "builtin", description: "Show MCP status" },
          { name: "/tasks", kind: "session", source: "builtin", description: "List tasks" },
          { name: "/help", kind: "session", source: "builtin", description: "List commands" },
          { name: "/status", kind: "session", source: "builtin", description: "Session status" },
          { name: "/version", kind: "session", source: "builtin", description: "Version" },
          { name: "/compact", kind: "session", source: "builtin", description: "Compact" },
          { name: "/remember", kind: "session", source: "builtin", description: "Remember" },
          { name: "/dream", kind: "session", source: "builtin", description: "Dream" },
          { name: "/profile", kind: "session", source: "builtin", description: "Profile" },
          { name: "/doctor", kind: "session", source: "builtin", description: "Doctor" },
          { name: "/effort", kind: "session", source: "builtin", description: "Effort" },
          { name: "/usage", kind: "session", source: "builtin", description: "Usage" },
          { name: "/cost", kind: "session", source: "builtin", description: "Cost" },
          { name: "/export", kind: "session", source: "builtin", description: "Export" },
          { name: "/output-style", kind: "session", source: "builtin", description: "Output style" },
          { name: "/init", kind: "session", source: "builtin", description: "Init project" },
          { name: "/plugin", kind: "session", source: "builtin", description: "Plugins" },
          { name: "/hooks", kind: "session", source: "builtin", description: "Hooks" },
          { name: "/subagents", kind: "session", source: "builtin", description: "Subagents" },
          { name: "/diff", kind: "session", source: "builtin", description: "Diff" },
          { name: "/branch", kind: "session", source: "builtin", description: "Branch" },
          { name: "/rewind", kind: "session", source: "builtin", description: "Rewind" },
          { name: "/commit", kind: "session", source: "builtin", description: "Commit" },
          { name: "/reload-plugins", kind: "session", source: "builtin", description: "Reload plugins" },
          { name: "/pr", kind: "template", source: "skill", description: "Write a PR" },
        ],
      });
    }
    if (pathname === "/output-styles") {
      return jsonResponse({
        styles: [
          { name: "default", content: "std", source: "builtin" },
          { name: "minimal", content: "terse", source: "builtin" },
        ],
      });
    }
    if (pathname === "/sessions/s1/usage") {
      return jsonResponse({
        model: "m",
        inputTokens: 11,
        outputTokens: 22,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        messageCount: 2,
        estimatedCost: "$0.0001",
      });
    }
    if (pathname === "/sessions/s1/export" && init?.method === "POST") {
      return jsonResponse({ format: "md", filepath: "/tmp/export.md", messageCount: 2 });
    }
    if (pathname === "/settings" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        settings: {
          model: "m",
          provider: typeof body.provider === "string" ? body.provider : "anthropic",
          permission: { mode: "default" },
          effort: body.effort ?? "medium",
          fastMode: body.fastMode ?? false,
          maxTurns: body.maxTurns ?? 50,
        },
      });
    }
    if (pathname === "/settings") {
      return jsonResponse({
        settings: {
          model: "m",
          provider: "openai",
          permission: { mode: "default" },
          effort: "medium",
          fastMode: false,
          maxTurns: 50,
          apiFormat: "openai",
        },
      });
    }
    if (pathname === "/dream" && init?.method === "POST") {
      return jsonResponse({ taskId: "dream_1" });
    }
    if (pathname === "/profile/init" && init?.method === "POST") {
      return jsonResponse({ report: "PROFILE INIT" });
    }
    if (pathname === "/profile") {
      return jsonResponse({ report: "PROFILE STATUS" });
    }
    if (pathname === "/sessions/s1/compact" && init?.method === "POST") {
      return jsonResponse({ messageCount: 2, messages: [], parts: [] });
    }
    if (pathname === "/sessions/s1/remember" && init?.method === "POST") {
      return jsonResponse({ skipped: false, writtenIds: ["mem2"], titles: ["pnpm tip"] });
    }
    if (pathname === "/providers") {
      return jsonResponse({
        providers: [
          { name: "openai", displayName: "OpenAI", hasKey: true, active: true },
          { name: "anthropic", displayName: "Anthropic", hasKey: false, active: false },
        ],
      });
    }
    if (pathname === "/tasks" && init?.method === "POST") {
      return jsonResponse({
        task: {
          id: "task_run_1",
          type: "shell",
          status: "running",
          description: "echo hi",
          cwd: process.cwd(),
          command: "echo hi",
          createdAt: 1,
        },
      });
    }
    if (pathname === "/tasks") {
      return jsonResponse({
        tasks: [{ id: "task_1", type: "shell", status: "running", description: "demo", cwd: process.cwd(), createdAt: 1 }],
      });
    }
    if (pathname === "/project/init" && init?.method === "POST") {
      return jsonResponse({ report: "Project initialized successfully." });
    }
    if (pathname === "/plugins/demo/enable" && init?.method === "POST") {
      return jsonResponse({ message: "Enabled plugin 'demo'." });
    }
    if (pathname === "/plugins") {
      return jsonResponse({
        plugins: [{
          name: "demo",
          version: "1.0.0",
          enabled: true,
          skillCount: 1,
          commandCount: 0,
          hookCount: 0,
          agentCount: 0,
        }],
        warnings: [],
      });
    }
    if (pathname === "/hooks") {
      return jsonResponse({
        hooks: [{
          id: "h1",
          event: "stop",
          type: "command",
          enabled: true,
          origin: "settings",
        }],
      });
    }
    if (pathname === "/agent-personas") {
      return jsonResponse({
        agents: [{ name: "Explore", description: "search files", source: "builtin" }],
      });
    }
    if (pathname === "/git/diff") {
      return jsonResponse({ output: "a.txt | 1 +\n" });
    }
    if (pathname === "/git/branch") {
      return jsonResponse({ output: "Current branch: main" });
    }
    if (pathname === "/sessions/s1/mcp") {
      return jsonResponse({
        servers: [{ name: "demo", status: "connected", toolCount: 1, resourceCount: 0, command: "demo" }],
      });
    }
    if (pathname === "/memory" && init?.method === "POST") {
      return jsonResponse({
        entry: { id: "mem1", content: "prefer pnpm", createdAt: 1, updatedAt: 1 },
      });
    }
    if (pathname === "/memory") {
      return jsonResponse({
        directory: "/tmp/memory",
        entries: [{ id: "mem1", content: "prefer pnpm", createdAt: 1, updatedAt: 1 }],
      });
    }
    if (pathname === "/auth") {
      return jsonResponse({
        auth: {
          codex: { configured: false, state: "missing", source: "/tmp/auth.json" },
          storedProviders: ["openai"],
          envProviders: [],
        },
      });
    }
    if (pathname === "/context") {
      if (holdNextContext) {
        holdNextContext = false;
        return await new Promise<Response>((resolve) => {
          releaseHeldContext = resolve;
        });
      }
      return jsonResponse({ report: "CONTEXT PREVIEW" });
    }
    if (pathname === "/sessions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { metadata?: Record<string, unknown> };
      return jsonResponse({
        session: {
          ...createdSession,
          metadata: body.metadata ?? createdSession.metadata,
        },
      });
    }
    if (pathname === "/sessions") {
      if (holdNextSessionList) {
        holdNextSessionList = false;
        return await new Promise<Response>((resolve) => {
          releaseHeldSessionList = resolve;
        });
      }
      return jsonResponse({ sessions: [session, childSession] });
    }
    if ((pathname === "/sessions/s1" || pathname === "/sessions/s2") && init?.method === "GET") {
      return jsonResponse({
        session: pathname.endsWith("/s2") ? createdSession : session,
      });
    }
    if ((pathname === "/sessions/s1" || pathname === "/sessions/s2") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        model?: string;
        metadata?: Record<string, unknown>;
      };
      const base = pathname.endsWith("/s2") ? createdSession : session;
      return jsonResponse({
        session: {
          ...base,
          model: body.model ?? base.model,
          metadata: body.metadata ? { ...base.metadata, ...body.metadata } : base.metadata,
          updatedAt: 9,
        },
      });
    }
    if (pathname === "/sessions/s1/commands" && init?.method === "POST") {
      return jsonResponse({
        input: { id: "i-cmd", sessionId: "s1", seq: 2, delivery: "queue", content: "PR PROMPT", metadata: {}, createdAt: 11 },
        run: { id: "r-cmd", sessionId: "s1", status: "running", metadata: {}, createdAt: 11, updatedAt: 11 },
        command: { name: "/pr", kind: "template", source: "skill" },
      });
    }
    if (pathname === "/sessions/s1/rewind" && init?.method === "POST") {
      return jsonResponse({ turns: 1, removed: 2, messages: [], parts: [] });
    }
    if (pathname === "/plugins/reload" && init?.method === "POST") {
      return jsonResponse({
        plugins: [{
          name: "demo",
          version: "1.0.0",
          enabled: true,
          skillCount: 1,
          commandCount: 0,
          hookCount: 0,
          agentCount: 0,
        }],
        warnings: [],
        message: "Plugins rediscovered; session runtimes will reload on next use.",
      });
    }
    if (pathname === "/git/status") {
      return jsonResponse({ output: " M README.md\n" });
    }
    if (pathname === "/git/commit" && init?.method === "POST") {
      return jsonResponse({ output: "[main abc123] fix auth" });
    }
    if (pathname === "/sessions/s1/state") {
      return jsonResponse({
        cursor: 6,
        session,
        inputs: [interruptedInput],
        messages: [message],
        parts: [textPart, toolPart],
        runs: [run, interruptedRun],
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
    if (pathname === "/sessions/s2/prompts") return jsonResponse({
      input: { id: "i2" },
      run: { id: "r2", sessionId: "s2", status: "running", metadata: {}, createdAt: 12, updatedAt: 12 },
    });
    if (pathname === "/sessions/s1/runs/r-interrupted/resume") {
      return jsonResponse({
        input: { ...interruptedInput, id: "i-recovery", metadata: { recovery: { sourceRunId: interruptedRun.id } } },
        run: { ...interruptedRun, id: "r-recovery", inputId: "i-recovery", status: "pending" },
        source_run: interruptedRun,
      });
    }
    if (pathname === "/permissions/p1/reply") {
      return jsonResponse({ request: { ...permission, status: "approved", decision: "once" } });
    }
    return jsonResponse({});
  }) as typeof fetch;

  let captured: TuiSessionController | undefined;
  function Harness() {
    captured = useServerSync({
      daemon: {
        url: "http://daemon.test",
        token: "tok",
        cwd: session.cwd,
        model: "m",
        permissionMode: "plan",
        maxTurns: 11,
      },
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
  expect(captured?.transcript.map((item) => item.text)).not.toContain("streaming now");
  expect(captured?.transcript.map((item) => item.text)).toContain(
    "Run interrupted: Daemon restarted before the run completed\nUse /resume r-interrupted to replay its original prompt.",
  );
  expect(captured?.assistantBuffer).toBe("streaming now");
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
    captured?.sendRequest({ type: "submit_line", line: "/resume r-interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const recoveryCall = calls.find((call) => call.url === "http://daemon.test/sessions/s1/runs/r-interrupted/resume");
  expect(recoveryCall?.init.method).toBe("POST");
  expect(JSON.parse(String(recoveryCall?.init.body ?? "{}"))).toMatchObject({ id: expect.any(String) });

  await act(async () => {
    holdNextSessionList = true;
    captured?.sendRequest({ type: "list_sessions" });
    await Promise.resolve();
  });
  const sessionOption = captured?.selectRequest?.options[0];
  expect(sessionOption?.value).toBe("s1");
  expect(sessionOption?.label === "TUI" || sessionOption?.label === "* TUI").toBe(true);
  expect(sessionOption?.description?.endsWith("| idle")).toBe(true);
  expect(captured?.selectRequest?.options.some((option) => String(option.label).includes("New session"))).toBe(false);
  expect(captured?.selectRequest?.options.some((option) => option.value === "child1")).toBe(false);
  expect(sessionOption?.description?.includes("\\") || sessionOption?.description?.includes("/")).toBe(false);
  expect(releaseHeldSessionList).toBeTruthy();

  await act(async () => {
    releaseHeldSessionList?.(jsonResponse({ sessions: [session, childSession] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.selectRequest?.options.some((option) => option.value === "child1")).toBe(false);

  await act(async () => {
    holdNextContext = true;
    captured?.sendRequest({ type: "submit_line", line: "/context" });
    await Promise.resolve();
  });
  expect(captured?.displayRequest?.title).toBe("Context");
  expect(captured?.displayRequest?.content).toBe("Loading...");
  expect(releaseHeldContext).toBeTruthy();

  await act(async () => {
    releaseHeldContext?.(jsonResponse({ report: "CONTEXT V1" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.displayRequest?.content).toBe("CONTEXT V1");

  await act(async () => {
    holdNextContext = true;
    captured?.sendRequest({ type: "submit_line", line: "/context" });
    await Promise.resolve();
  });
  expect(captured?.displayRequest?.content).toBe("CONTEXT V1");
  await act(async () => {
    releaseHeldContext?.(jsonResponse({ report: "CONTEXT V2" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.displayRequest?.content).toBe("CONTEXT V2");

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/new Scratch" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  let createCall = calls.find((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST");
  expect(createCall).toBeUndefined();
  expect(captured?.status.session_id).toBeUndefined();
  expect(captured?.busy).toBe(false);

  await act(async () => {
    captured?.sendRequest({ type: "list_sessions" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.selectRequest?.title).toBe("Sessions");
  expect(captured?.selectRequest?.options[0]?.value).toBe("s1");

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "first scratch prompt" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  createCall = calls.find((call) => call.url === "http://daemon.test/sessions" && call.init.method === "POST");
  expect(createCall).toBeTruthy();
  expect(JSON.parse(String(createCall?.init.body ?? "{}"))).toMatchObject({
    title: "Scratch",
    metadata: { permissionMode: "plan", maxTurns: 11 },
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s2/prompts")).toBe(true);
  expect(captured?.status.session_id).toBe("s2");
  expect(captured?.busy).toBe(true);

  await act(async () => {
    captured?.sendRequest({ type: "set_permission_mode", permission_mode: "full_auto" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const permissionPatch = calls.find((call) =>
    call.url === "http://daemon.test/sessions/s2" && call.init.method === "PATCH"
      && String(call.init.body ?? "").includes("permissionMode"));
  expect(permissionPatch).toBeTruthy();
  expect(captured?.status.permission_mode).toBe("full_auto");

  await act(async () => {
    captured?.sendRequest({ type: "delete_session", session_id: "s2" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s2" && call.init.method === "DELETE")).toBe(true);
  expect(captured?.status.session_id).toBe("s1");

  expect(captured?.commands).toEqual(expect.arrayContaining(["/new", "/model", "/pr", "/skills"]));

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/model gpt-test" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s1" && call.init.method === "PATCH")).toBe(true);
  expect(captured?.status.model).toBe("gpt-test");
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Model set to gpt-test"))).toBe(true);

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/pr fix auth" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s1/commands" && call.init.method === "POST")).toBe(true);

  const promptCallsBeforeUnknown = calls.filter((call) => call.url.includes("/prompts")).length;
  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/definitely-not-a-command" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.filter((call) => call.url.includes("/prompts")).length).toBe(promptCallsBeforeUnknown);
  expect(captured?.transcript.some((item) =>
    item.role === "system" && item.text.includes("Unknown command: /definitely-not-a-command"),
  )).toBe(true);

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/help" });
    captured?.sendRequest({ type: "submit_line", line: "/config show" });
    captured?.sendRequest({ type: "submit_line", line: "/provider" });
    captured?.sendRequest({ type: "submit_line", line: "/mcp" });
    captured?.sendRequest({ type: "submit_line", line: "/tasks" });
    captured?.sendRequest({ type: "submit_line", line: "/memory" });
    captured?.sendRequest({ type: "submit_line", line: "/auth" });
    captured?.sendRequest({ type: "submit_line", line: "/context" });
    captured?.sendRequest({ type: "submit_line", line: "/stats" });
    captured?.sendRequest({ type: "submit_line", line: "/agents" });
    captured?.sendRequest({ type: "submit_line", line: "/compact" });
    captured?.sendRequest({ type: "submit_line", line: "/remember" });
    captured?.sendRequest({ type: "submit_line", line: "/dream" });
    captured?.sendRequest({ type: "submit_line", line: "/profile" });
    captured?.sendRequest({ type: "submit_line", line: "/doctor" });
    captured?.sendRequest({ type: "submit_line", line: "/effort high" });
    captured?.sendRequest({ type: "submit_line", line: "/usage" });
    captured?.sendRequest({ type: "submit_line", line: "/cost" });
    captured?.sendRequest({ type: "submit_line", line: "/export" });
    captured?.sendRequest({ type: "submit_line", line: "/output-style list" });
    captured?.sendRequest({ type: "submit_line", line: "/tasks run echo hi" });
    captured?.sendRequest({ type: "submit_line", line: "/init" });
    captured?.sendRequest({ type: "submit_line", line: "/plugin" });
    captured?.sendRequest({ type: "submit_line", line: "/hooks" });
    captured?.sendRequest({ type: "submit_line", line: "/subagents" });
    captured?.sendRequest({ type: "submit_line", line: "/diff" });
    captured?.sendRequest({ type: "submit_line", line: "/branch" });
    captured?.sendRequest({ type: "submit_line", line: "/rewind 1" });
    captured?.sendRequest({ type: "submit_line", line: "/reload-plugins" });
    captured?.sendRequest({ type: "submit_line", line: "/commit" });
    captured?.sendRequest({ type: "submit_line", line: "/commit fix auth" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Available commands:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes('"provider": "openai"'))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("OpenAI"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("MCP Servers"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("task_1"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("prefer pnpm"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Credential status:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("CONTEXT PREVIEW"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Session stats:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("No agent tasks."))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Conversation compacted"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("已写入"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Dream 已启动"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("PROFILE STATUS"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("OpenHarness Environment Diagnostic"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Effort set to: high"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Token usage:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Cost estimate:"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Exported Markdown to:"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("* default"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Task started: task_run_1"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Project initialized successfully."))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("demo@1.0.0"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("h1: stop"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Explore"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("a.txt | 1 +"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Current branch: main"))).toBe(false);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Rewound 1 turn(s)"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("Reloaded plugins:"))).toBe(true);
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("M README.md"))).toBe(false);

  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/commit" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(captured?.displayRequest?.title).toBe("Commit");
  expect(captured?.displayRequest?.content).toContain("M README.md");
  expect(captured?.transcript.some((item) => item.role === "system" && item.text.includes("[main abc123] fix auth"))).toBe(true);

  const createCallsBeforeImmediateNew = calls.filter((call) =>
    call.url === "http://daemon.test/sessions" && call.init.method === "POST"
  ).length;
  const oldPromptCallsBeforeImmediateNew = calls.filter((call) =>
    call.url === "http://daemon.test/sessions/s1/prompts"
  ).length;
  await act(async () => {
    captured?.sendRequest({ type: "submit_line", line: "/new Isolated" });
    captured?.sendRequest({ type: "submit_line", line: "isolated prompt" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(calls.filter((call) =>
    call.url === "http://daemon.test/sessions" && call.init.method === "POST"
  )).toHaveLength(createCallsBeforeImmediateNew + 1);
  expect(calls.filter((call) => call.url === "http://daemon.test/sessions/s1/prompts")).toHaveLength(
    oldPromptCallsBeforeImmediateNew,
  );
  expect(calls.some((call) => call.url === "http://daemon.test/sessions/s2/prompts")).toBe(true);
  expect(captured?.status.session_id).toBe("s2");
  expect(captured?.transcript.some((item) =>
    item.text.includes("Unknown command: /definitely-not-a-command") || item.text.includes("Model set to gpt-test"),
  )).toBe(false);

  renderer.destroy();
});
