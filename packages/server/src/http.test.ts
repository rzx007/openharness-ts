import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWorkflowPlan, createWorkflowRunSnapshot, WorkflowRunStore } from "@openharness/coordinator";
import type { CommandCatalogProvider } from "./commands.js";
import { OpenHarnessHttpServer } from "./http.js";
import { getDefaultSessionStorePath } from "./paths.js";
import type { ChildSessionHost, SessionRuntimeFactory, SessionTaskBridge } from "./runtime.js";
import type { OpenHarnessServerOptions } from "./http.js";
import type { ObservabilityEvent } from "./observability.js";

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
  test: (ctx: { baseUrl: string; token: string; storePath: string; server: OpenHarnessHttpServer }) => Promise<void>,
  options: Pick<
    OpenHarnessServerOptions,
    | "runtimeFactory"
    | "allowedOrigins"
    | "commandCatalog"
    | "settingsService"
    | "providerService"
    | "memoryService"
    | "authService"
    | "contextService"
    | "dreamService"
    | "profileService"
    | "outputStyleService"
    | "projectInitService"
    | "pluginService"
    | "agentPersonaService"
    | "hooksService"
    | "gitService"
    | "logger"
  > = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohs-server-"));
  const token = "test-token";
  const server = new OpenHarnessHttpServer({
    token,
    allowedOrigins: options.allowedOrigins,
    storePath: join(dir, "sessions.db"),
    runtimeFactory: options.runtimeFactory,
    commandCatalog: options.commandCatalog,
    settingsService: options.settingsService,
    providerService: options.providerService,
    memoryService: options.memoryService,
    authService: options.authService,
    contextService: options.contextService,
    dreamService: options.dreamService,
    profileService: options.profileService,
    outputStyleService: options.outputStyleService,
    projectInitService: options.projectInitService,
    pluginService: options.pluginService,
    agentPersonaService: options.agentPersonaService,
    hooksService: options.hooksService,
    gitService: options.gitService,
    logger: options.logger ?? (() => {}),
  });
  const listen = await server.listen();
  try {
    await test({ baseUrl: listen.url, token, storePath: join(dir, "sessions.db"), server });
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
  it("provides runtimes an in-process child session host", async () => {
    type Host = {
      createChildSession(input: {
        parentId: string;
        cwd: string;
        model?: string;
        title: string;
        agent: string;
      }): Promise<{ id: string }>;
      admitPrompt(sessionId: string, content: string): Promise<{ runId?: string }>;
      awaitRun(sessionId: string, runId: string): Promise<{ status: string; output: string }>;
      closeRuntime(sessionId: string): Promise<void>;
    };
    let host: Host | undefined;
    let taskBridge: SessionTaskBridge | undefined;
    const created: string[] = [];
    const closed: string[] = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime(context) {
        host = (context as typeof context & { childSessionHost?: Host }).childSessionHost;
        taskBridge = context.sessionTaskBridge;
        created.push(context.session.id);
        return {
          async runPrompt(_input, hooks) {
            await hooks.onStreamEvent({ type: "text_delta", delta: "child output" });
            return { messages: [] };
          },
          async close() {
            closed.push(context.session.id);
          },
        };
      },
    };

    await withServer(async ({ baseUrl, token, server }) => {
      const response = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "parent", cwd: process.cwd(), model: "m" }),
      });
      expect(response.status).toBe(201);
      for (let i = 0; i < 20 && !host; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(host).toBeDefined();

      const child = await host!.createChildSession({
        parentId: "parent",
        cwd: process.cwd(),
        title: "Explore@default",
        agent: "Explore",
      });
      expect(server.store.getSession(child.id)?.parentId).toBe("parent");
      expect(server.store.getSession(child.id)?.model).toBe("m");

      const admitted = await host!.admitPrompt(child.id, "inspect");
      expect(admitted.runId).toBeTruthy();
      const task = taskBridge!.registerSessionTask({
        description: "Explore@default",
        cwd: process.cwd(),
        sessionId: "parent",
        childSessionId: child.id,
        prompt: "inspect",
        onInput: async () => {},
        onStop: async () => {},
      });
      await taskBridge!.bindSessionTaskRun(task.id, admitted.runId!);
      await expect(host!.awaitRun(child.id, admitted.runId!)).resolves.toMatchObject({
        status: "completed",
        output: "child output",
      });
      await taskBridge!.completeSessionTask(task.id, { status: "completed", output: "child output" });
      expect(server.store.getSessionTask(task.id)).toMatchObject({
        sessionId: "parent",
        childSessionId: child.id,
        runId: admitted.runId,
        status: "completed",
      });
      await host!.closeRuntime(child.id);
      expect(closed).toContain(child.id);

      const followUp = await host!.admitPrompt(child.id, "follow up");
      await expect(host!.awaitRun(child.id, followUp.runId!)).resolves.toMatchObject({
        status: "completed",
      });
      expect(created.filter((id) => id === child.id)).toHaveLength(2);
      expect(server.store.getSession(child.id)?.status).not.toBe("archived");
    }, { runtimeFactory });
  });

  it("uses the canonical session runtime store", () => {
    expect(getDefaultSessionStorePath()).toMatch(/[\\/]session-runtime[\\/]sessions\.db$/);
  });

  it("serves health and protects routes with bearer auth", async () => {
    await withServer(async ({ baseUrl, token }) => {
      expect((await fetch(`${baseUrl}/health`)).status).toBe(401);
      const response = await fetch(`${baseUrl}/health`, { headers: auth(token) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        startedAt: expect.any(Number),
        uptimeMs: expect.any(Number),
        sessionCount: 0,
        activeRunCount: 0,
        queuedRunCount: 0,
      });

      expect((await fetch(`${baseUrl}/debug/runtime`)).status).toBe(401);
      const runtime = await fetch(`${baseUrl}/debug/runtime`, { headers: auth(token) });
      expect(runtime.status).toBe(200);
      expect(await runtime.json()).toMatchObject({
        startedAt: expect.any(Number),
        uptimeMs: expect.any(Number),
        sessions: { total: 0, byStatus: {} },
        runs: { total: 0, byStatus: {} },
        tasks: { total: 0, byStatus: {} },
        permissions: { total: 0, byStatus: {} },
        sseClientCount: 0,
        warmRuntimeCount: 0,
        coordinator: { activeRunCount: 0, queuedRunCount: 0 },
      });
    });
  });

  it("reports aggregate running and queued work without transcript content", async () => {
    const releaseFirst = deferred();
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            if (input.input.content === "private first prompt") await releaseFirst.promise;
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
        body: JSON.stringify({ content: "private first prompt" }),
      });
      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "running",
      );
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "private queued prompt" }),
      });

      const response = await fetch(`${baseUrl}/debug/runtime`, { headers: auth(token) });
      expect(response.status).toBe(200);
      const snapshot = await response.json() as {
        sessions: { total: number; byStatus: Record<string, number> };
        runs: { total: number; byStatus: Record<string, number> };
        sseClientCount: number;
        warmRuntimeCount: number;
        coordinator: { activeRunCount: number; queuedRunCount: number };
      };
      expect(snapshot).toMatchObject({
        sessions: { total: 1, byStatus: { running: 1 } },
        runs: { total: 2, byStatus: { running: 1, pending: 1 } },
        sseClientCount: 0,
        warmRuntimeCount: 1,
        coordinator: { activeRunCount: 1, queuedRunCount: 1 },
      });
      expect(JSON.stringify(snapshot)).not.toContain("private");

      releaseFirst.resolve();
      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "completed",
      );
    }, { runtimeFactory });
  });

  it("propagates a trace ID through HTTP, persisted prompt/run, and tool lifecycle logs", async () => {
    const events: ObservabilityEvent[] = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(_input, hooks) {
            await hooks.onStreamEvent({
              type: "tool_use_start",
              toolUse: { type: "tool_use", id: "tool-1", name: "Read", input: { path: "README.md" } },
            });
            await hooks.onStreamEvent({
              type: "tool_use_end",
              toolUseId: "tool-1",
              result: { content: [{ type: "text", text: "ok" }] },
            });
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token, server }) => {
      const traceId = "trace-e2e-001";
      const created = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ cwd: process.cwd(), model: "m" }),
      });
      const session = (await created.json() as { session: { id: string } }).session;
      const response = await fetch(`${baseUrl}/sessions/${session.id}/prompts`, {
        method: "POST",
        headers: {
          ...auth(token),
          "content-type": "application/json",
          "x-openharness-trace-id": traceId,
        },
        body: JSON.stringify({ id: "prompt-trace-1", content: "inspect" }),
      });
      expect(response.status).toBe(202);
      expect(response.headers.get("x-openharness-trace-id")).toBe(traceId);
      const admitted = await response.json() as {
        input: { metadata: Record<string, unknown> };
        run: { id: string; metadata: Record<string, unknown> };
      };
      expect(admitted.input.metadata.traceId).toBe(traceId);
      expect(admitted.run.metadata.traceId).toBe(traceId);

      for (let i = 0; i < 20 && server.store.getRun(admitted.run.id)?.status !== "completed"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(server.store.getRun(admitted.run.id)?.status).toBe("completed");
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "http.request.completed", traceId, path: `/sessions/${session.id}/prompts` }),
        expect.objectContaining({ event: "session.run.started", traceId, sessionId: session.id, runId: admitted.run.id }),
        expect.objectContaining({ event: "session.tool.started", traceId, toolName: "Read" }),
        expect.objectContaining({ event: "session.tool.completed", traceId, toolName: "Read" }),
        expect.objectContaining({ event: "session.run.completed", traceId, sessionId: session.id, runId: admitted.run.id }),
      ]));
    }, { runtimeFactory, logger: (event) => events.push(event) });
  });

  it("permits only configured browser origins and handles unauthenticated preflight", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const preflight = await fetch(`${baseUrl}/sessions`, {
        method: "OPTIONS",
        headers: {
          origin: "https://desk.example",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://desk.example");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("x-openharness-trace-id");

      const allowed = await fetch(`${baseUrl}/health`, {
        headers: { ...auth(token), origin: "https://desk.example" },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://desk.example");
      expect(allowed.headers.get("access-control-expose-headers")).toContain("x-openharness-trace-id");

      const denied = await fetch(`${baseUrl}/health`, {
        headers: { ...auth(token), origin: "https://untrusted.example" },
      });
      expect(denied.status).toBe(403);
    }, { allowedOrigins: ["https://desk.example"] });
  });

  it("reloads sessions/messages/events after a daemon restart and interrupts leftover runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-server-restart-"));
    const storePath = join(dir, "sessions.db");
    const token = "test-token";
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          async compact() {
            return {
              messageCount: 1,
              transcript: [{
                role: "user",
                parts: [{ type: "text", status: "completed", text: "survived restart" }],
              }],
            };
          },
        };
      },
    };
    try {
      const first = new OpenHarnessHttpServer({ token, storePath, runtimeFactory });
      const listen1 = await first.listen();
      try {
        await fetch(`${listen1.url}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m", title: "Keep me" }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fetch(`${listen1.url}/sessions/s1/compact`, {
          method: "POST",
          headers: auth(token),
        });
        // Simulate a previous daemon crash leaving an active run on disk.
        first.store.createRun({ id: "r-stale", sessionId: "s1" });
        first.store.createSessionTask({
          id: "task-stale", sessionId: "s1", type: "agent", description: "stale child", cwd: process.cwd(),
        });
      } finally {
        await first.close();
      }

      const second = new OpenHarnessHttpServer({ token, storePath });
      const listen2 = await second.listen();
      try {
        const sessions = await (await fetch(`${listen2.url}/sessions`, { headers: auth(token) })).json() as {
          sessions: Array<{ id: string; title: string }>;
        };
        expect(sessions.sessions.map((row) => row.id)).toEqual(["s1"]);
        expect(sessions.sessions[0]?.title).toBe("Keep me");

        const state = await (await fetch(`${listen2.url}/sessions/s1/state`, { headers: auth(token) })).json() as {
          messages: Array<{ role: string }>;
          parts: Array<{ text?: string }>;
          runs: Array<{ id: string; status: string }>;
          tasks: Array<{ id: string; status: string }>;
        };
        expect(state.messages).toHaveLength(1);
        expect(state.parts[0]?.text).toBe("survived restart");
        expect(state.runs.find((run) => run.id === "r-stale")?.status).toBe("interrupted");
        expect(state.tasks.find((task) => task.id === "task-stale")?.status).toBe("interrupted");

        const events = await (await fetch(`${listen2.url}/events`, { headers: auth(token) })).json() as {
          events: Array<{ type: string }>;
        };
        expect(events.events.map((event) => event.type)).toContain("session.transcript.replaced");
        expect(events.events.map((event) => event.type)).toContain("session.run.updated");
        expect(events.events.map((event) => event.type)).toContain("session.task.updated");
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays an interrupted prompt only after an explicit, idempotent recovery request", async () => {
    const prompts: string[] = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            prompts.push(input.input.content);
            return { messages: [] };
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token, server }) => {
      const session = server.store.createSession({ id: "s1", cwd: process.cwd(), model: "m" });
      const input = server.store.admitPrompt({ id: "input-before-restart", sessionId: session.id, content: "finish the report" });
      const interrupted = server.store.createRun({ id: "run-before-restart", sessionId: session.id, inputId: input.id });
      server.store.updateRun(interrupted.id, {
        status: "interrupted",
        error: "Daemon restarted before the run completed",
      });

      const first = await fetch(`${baseUrl}/sessions/s1/runs/run-before-restart/resume`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "recovery-request-1" }),
      });
      expect(first.status).toBe(202);
      const recovered = await first.json() as {
        input: { id: string; content: string; metadata: Record<string, unknown> };
        run?: { id: string; metadata: Record<string, unknown> };
        source_run: { id: string; status: string };
      };
      expect(recovered).toMatchObject({
        input: {
          content: "finish the report",
          metadata: { recovery: { kind: "prompt_replay", sourceRunId: "run-before-restart", sourceInputId: "input-before-restart" } },
        },
        run: { metadata: { recovery: { sourceRunId: "run-before-restart" } } },
        source_run: { id: "run-before-restart", status: "interrupted" },
      });
      expect(recovered.run?.id).toBeTruthy();

      await waitForEvent(baseUrl, token, (event) => event.type === "session.run.recovery_requested");
      expect(prompts).toEqual(["finish the report"]);

      const retry = await fetch(`${baseUrl}/sessions/s1/runs/run-before-restart/resume`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "recovery-request-1" }),
      });
      expect(retry.status).toBe(202);
      expect((await retry.json() as { run?: { id: string } }).run?.id).toBe(recovered.run?.id);
      expect(server.store.listEvents({ sessionId: "s1" }).filter((event) => event.type === "session.run.recovery_requested")).toHaveLength(1);

      const duplicate = await fetch(`${baseUrl}/sessions/s1/runs/run-before-restart/resume`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "different-recovery-request" }),
      });
      expect(duplicate.status).toBe(409);
      expect(server.store.getRun("run-before-restart")?.status).toBe("interrupted");
    }, { runtimeFactory });
  });

  it("terminalizes daemon-owned running workflows after restart without touching unrelated project workflows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-server-workflow-restart-"));
    const storePath = join(dir, "sessions.db");
    const projectCwd = join(dir, "project");
    const workflowStore = new WorkflowRunStore({ cwd: projectCwd });
    const spec = {
      mode: "sequential" as const,
      tasks: [{ id: "child", prompt: "finish the child task" }],
    };
    const plan = createWorkflowPlan(spec);
    const now = Date.now();
    const createRunningSnapshot = (runId: string) => createWorkflowRunSnapshot({
      runId,
      status: "running",
      summary: "Workflow started",
      spec,
      plan,
      results: new Map(),
      running: new Set(["child"]),
      runningTasks: new Map([["child", {
        taskId: "child",
        attempt: 1,
        dependencies: [],
        startedAt: now,
        summary: "Child session is running",
        metadata: { taskManagerTaskId: "task-lost-with-daemon" },
      }]]),
      createdAt: now,
    });
    const daemonRunId = "wf-daemon-owned";
    const unrelatedRunId = "wf-cli-owned";
    const corruptRunId = "wf-corrupt";
    workflowStore.save(createRunningSnapshot(daemonRunId));
    workflowStore.save(createRunningSnapshot(unrelatedRunId));

    try {
      const first = new OpenHarnessHttpServer({ storePath });
      const parent = first.store.createSession({ id: "parent", cwd: projectCwd, model: "m", title: "parent" });
      const child = first.store.createSession({ id: "child", parentId: parent.id, cwd: projectCwd, model: "m", title: "child" });
      const staleChildRun = first.store.createRun({ id: "child-run", sessionId: child.id });
      first.store.updateRun(staleChildRun.id, { status: "running" });
      first.store.appendEvent({
        type: "workflow.workflow_started",
        sessionId: parent.id,
        payload: {
          event: {
            version: 1,
            runId: daemonRunId,
            type: "workflow_started",
            timestamp: now,
            status: "running",
          },
        },
      });
      writeFileSync(workflowStore.pathFor(corruptRunId), "{ not valid JSON", "utf-8");
      first.store.appendEvent({
        type: "workflow.workflow_started",
        sessionId: parent.id,
        payload: {
          event: {
            version: 1,
            runId: corruptRunId,
            type: "workflow_started",
            timestamp: now,
            status: "running",
          },
        },
      });

      await first.close();
      const second = new OpenHarnessHttpServer({ storePath });
      await second.listen();
      try {
        const recovered = workflowStore.load(daemonRunId)!;
        expect(recovered.status).toBe("failed");
        expect(recovered.results.child).toMatchObject({
          status: "killed",
          summary: "Daemon restarted before the workflow completed",
        });
        expect(recovered.runningTaskIds).toEqual([]);
        expect(workflowStore.load(unrelatedRunId)?.status).toBe("running");
        expect(second.store.getRun(staleChildRun.id)).toMatchObject({ status: "interrupted" });
        expect(second.store.listChildSessions(parent.id).map((session) => session.id)).toEqual([child.id]);
        expect(second.store.listEvents({ sessionId: parent.id }).find((event) => event.type === "workflow.workflow_cancelled"))
          .toMatchObject({ payload: { recoveredAfterDaemonRestart: true } });
        expect(second.store.listEvents({ sessionId: parent.id }).find((event) => event.type === "workflow.workflow_recovery_failed"))
          .toMatchObject({ payload: { runId: corruptRunId, recoveredAfterDaemonRestart: true } });
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists builtin session commands and provider template commands by cwd", async () => {
    const commandCatalog: CommandCatalogProvider = {
      async list({ cwd }) {
        expect(cwd).toBe(process.cwd());
        return [
          {
            name: "/pr",
            description: "Write a PR",
            kind: "template",
            source: "skill",
          },
        ];
      },
    };
    await withServer(async ({ baseUrl, token }) => {
      const response = await fetch(`${baseUrl}/commands?cwd=${encodeURIComponent(process.cwd())}`, {
        headers: auth(token),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        commands: Array<{ name: string; kind: string; description?: string }>;
      };
      expect(body.commands.map((command) => command.name)).toEqual(
        expect.arrayContaining(["/model", "/skills", "/pr", "/commit"]),
      );
      expect(body.commands.find((command) => command.name === "/pr")).toMatchObject({
        kind: "template",
        description: "Write a PR",
      });
      expect(body.commands.find((command) => command.name === "/commit")).toMatchObject({
        kind: "session",
      });
    }, { commandCatalog });
  });

  it("expands template commands into admitted prompts", async () => {
    const commandCatalog: CommandCatalogProvider = {
      async list() {
        return [{ name: "/pr", description: "PR", kind: "template", source: "skill" }];
      },
      async expand({ name, args }) {
        if (name !== "/pr") return null;
        return {
          prompt: `PR PROMPT\n## Arguments\n${args}`,
          command: { name: "/pr", kind: "template", source: "skill" },
        };
      },
    };
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });
      const response = await fetch(`${baseUrl}/sessions/s1/commands`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ name: "/pr", args: "fix parser" }),
      });
      expect(response.status).toBe(202);
      const body = await response.json() as {
        input: { content: string };
        command: { name: string; kind: string };
      };
      expect(body.command).toMatchObject({ name: "/pr", kind: "template" });
      expect(body.input.content).toContain("PR PROMPT");
      expect(body.input.content).toContain("fix parser");
    }, { commandCatalog });
  });

  it("patches session model via PATCH /sessions/:id", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "old-model" }),
      });
      const patched = await fetch(`${baseUrl}/sessions/s1`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ model: "new-model" }),
      });
      expect(patched.status).toBe(200);
      const body = await patched.json() as { session: { model: string } };
      expect(body.session.model).toBe("new-model");

      const events = await (await fetch(`${baseUrl}/events`, { headers: auth(token) })).json() as {
        events: Array<{ type: string }>;
      };
      expect(events.events.map((event) => event.type)).toContain("session.updated");
    });
  });

  it("merges session metadata and closes runtime when permissionMode changes", async () => {
    const created: string[] = [];
    const closed: string[] = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime(context) {
        created.push(context.session.id);
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {
            closed.push(context.session.id);
          },
        };
      },
    };

    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          id: "s1",
          cwd: process.cwd(),
          model: "m",
          metadata: { maxTurns: 9, permissionMode: "default" },
        }),
      });
      for (let i = 0; i < 20 && created.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(created).toEqual(["s1"]);

      const patched = await fetch(`${baseUrl}/sessions/s1`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ metadata: { permissionMode: "plan" } }),
      });
      expect(patched.status).toBe(200);
      const body = await patched.json() as {
        session: { metadata: Record<string, unknown> };
      };
      expect(body.session.metadata).toEqual({
        maxTurns: 9,
        permissionMode: "plan",
      });
      expect(closed).toContain("s1");

      await fetch(`${baseUrl}/sessions/s1`, { headers: auth(token) });
      for (let i = 0; i < 20 && created.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(created.filter((id) => id === "s1")).toHaveLength(2);
    }, { runtimeFactory });
  });

  it("serves settings and providers through resource APIs", async () => {
    let current = { model: "m", provider: "openai", permission: { mode: "default" } };
    let restart = false;
    await withServer(async ({ baseUrl, token }) => {
      const settings = await (await fetch(`${baseUrl}/settings`, { headers: auth(token) })).json() as {
        settings: { model: string };
      };
      expect(settings.settings.model).toBe("m");

      const patched = await fetch(`${baseUrl}/settings`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      });
      expect(patched.status).toBe(200);
      expect(restart).toBe(true);
      expect(((await patched.json()) as { settings: { provider: string } }).settings.provider).toBe("anthropic");

      const providers = await (await fetch(`${baseUrl}/providers`, { headers: auth(token) })).json() as {
        providers: Array<{ name: string; active: boolean }>;
      };
      expect(providers.providers).toEqual([
        { name: "openai", displayName: "OpenAI", hasKey: true, active: false },
        { name: "anthropic", displayName: "Anthropic", hasKey: false, active: true },
      ]);
    }, {
      settingsService: {
        get: () => current,
        patch: (patch) => {
          current = { ...current, ...patch, permission: current.permission };
          restart = true;
          return { settings: current, restartRuntimes: true };
        },
      },
      providerService: {
        list: () => [
          { name: "openai", displayName: "OpenAI", hasKey: true, active: current.provider === "openai" },
          { name: "anthropic", displayName: "Anthropic", hasKey: false, active: current.provider === "anthropic" },
        ],
      },
    });
  });

  it("lists and stops session-scoped tasks", async () => {
    const { getTaskManager, resetTaskManager } = await import("@openharness/services");
    const cwd = process.cwd();
    resetTaskManager({ cwd, sessionId: "s1" });
    const manager = getTaskManager({ cwd, sessionId: "s1" });
    const task = await manager.createShellTask({
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      description: "long runner",
      cwd,
      sessionId: "s1",
    });
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd, model: "m" }),
      });
      const listed = await (await fetch(`${baseUrl}/tasks?sessionId=s1`, { headers: auth(token) })).json() as {
        tasks: Array<{ id: string }>;
      };
      expect(listed.tasks.map((row) => row.id)).toContain(task.id);

      const stopped = await fetch(`${baseUrl}/tasks/${task.id}/stop?sessionId=s1`, {
        method: "POST",
        headers: auth(token),
      });
      expect(stopped.status).toBe(200);
      expect(((await stopped.json()) as { task: { status: string } }).task.status).toBe("stopped");
    });
    resetTaskManager({ cwd, sessionId: "s1" });
  });

  it("returns MCP inspect status for a warmed session runtime", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          inspect() {
            return {
              mcpServers: [
                { name: "demo", status: "connected", toolCount: 2, resourceCount: 1, command: "demo" },
              ],
            };
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
      // Wait briefly for warmRuntime.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await fetch(`${baseUrl}/sessions/s1/mcp`, { headers: auth(token) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        servers: [{ name: "demo", status: "connected", toolCount: 2, resourceCount: 1, command: "demo" }],
      });
    }, { runtimeFactory });
  });

  it("manages memory entries via resource APIs", async () => {
    const entries = new Map<string, {
      id: string;
      content: string;
      tags?: string[];
      createdAt: number;
      updatedAt: number;
    }>();
    await withServer(async ({ baseUrl, token }) => {
      const created = await fetch(`${baseUrl}/memory`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ cwd: process.cwd(), content: "prefer pnpm" }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as { entry: { id: string; content: string } };
      expect(createdBody.entry.content).toBe("prefer pnpm");

      const listed = await (await fetch(
        `${baseUrl}/memory?cwd=${encodeURIComponent(process.cwd())}`,
        { headers: auth(token) },
      )).json() as { directory: string; entries: Array<{ id: string }> };
      expect(listed.directory).toBe("/tmp/memory");
      expect(listed.entries.map((entry) => entry.id)).toContain(createdBody.entry.id);

      const removed = await fetch(
        `${baseUrl}/memory/${createdBody.entry.id}?cwd=${encodeURIComponent(process.cwd())}`,
        { method: "DELETE", headers: auth(token) },
      );
      expect(removed.status).toBe(200);
    }, {
      memoryService: {
        async list() {
          return { directory: "/tmp/memory", entries: [...entries.values()] };
        },
        async get({ id }) {
          return entries.get(id) ?? null;
        },
        async add({ content, tags }) {
          const entry = {
            id: `m${entries.size + 1}`,
            content,
            ...(tags ? { tags } : {}),
            createdAt: 1,
            updatedAt: 1,
          };
          entries.set(entry.id, entry);
          return entry;
        },
        async remove({ id }) {
          return entries.delete(id);
        },
      },
    });
  });

  it("manages auth status/login/logout via resource APIs", async () => {
    const stored = new Set<string>();
    await withServer(async ({ baseUrl, token }) => {
      const status = await (await fetch(`${baseUrl}/auth`, { headers: auth(token) })).json() as {
        auth: { storedProviders: string[]; codex: { configured: boolean } };
      };
      expect(status.auth.storedProviders).toEqual([]);
      expect(status.auth.codex.configured).toBe(false);

      const login = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
      });
      expect(login.status).toBe(200);
      expect(stored.has("openai")).toBe(true);

      const logout = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      expect(logout.status).toBe(200);
      expect(stored.has("openai")).toBe(false);
    }, {
      authService: {
        async status() {
          return {
            codex: { configured: false, state: "missing", source: "/tmp/auth.json" },
            storedProviders: [...stored],
            envProviders: [],
          };
        },
        async login({ provider, apiKey }) {
          if (!apiKey) throw new Error("apiKey required");
          stored.add(provider);
          return { message: `stored ${provider}` };
        },
        async logout({ provider }) {
          stored.delete(provider);
          return { message: `cleared ${provider}` };
        },
      },
    });
  });

  it("returns context preview reports", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const response = await fetch(
        `${baseUrl}/context?cwd=${encodeURIComponent(process.cwd())}`,
        { headers: auth(token) },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ report: "CONTEXT REPORT" });
    }, {
      contextService: {
        async preview() {
          return { report: "CONTEXT REPORT" };
        },
      },
    });
  });

  it("compacts a session transcript through the runtime and store", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          async compact() {
            return {
              messageCount: 1,
              transcript: [{
                role: "assistant",
                parts: [{ type: "text", status: "completed", text: "summary" }],
              }],
            };
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await fetch(`${baseUrl}/sessions/s1/compact`, {
        method: "POST",
        headers: auth(token),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        messageCount: number;
        messages: Array<{ role: string }>;
        parts: Array<{ text?: string }>;
      };
      expect(body.messageCount).toBe(1);
      expect(body.messages).toHaveLength(1);
      expect(body.parts[0]?.text).toBe("summary");
      const events = await (await fetch(`${baseUrl}/events`, { headers: auth(token) })).json() as {
        events: Array<{ type: string }>;
      };
      expect(events.events.map((event) => event.type)).toContain("session.transcript.replaced");
    }, { runtimeFactory });
  });

  it("returns session usage and exports transcript files", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          getUsage() {
            return {
              inputTokens: 10,
              outputTokens: 20,
              cacheCreationTokens: 1,
              cacheReadTokens: 2,
              messageCount: 1,
            };
          },
        };
      },
    };
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "gpt-4o-mini" }),
      });
      const usage = await fetch(`${baseUrl}/sessions/s1/usage`, { headers: auth(token) });
      expect(usage.status).toBe(200);
      const usageBody = await usage.json() as {
        inputTokens: number;
        outputTokens: number;
        estimatedCost: string;
        model: string;
      };
      expect(usageBody.model).toBe("gpt-4o-mini");
      expect(usageBody.inputTokens).toBe(10);
      expect(usageBody.outputTokens).toBe(20);
      expect(usageBody.estimatedCost).toMatch(/^\$/);

      const emptyExport = await fetch(`${baseUrl}/sessions/s1/export`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(emptyExport.status).toBe(400);
    }, { runtimeFactory });
  });

  it("lists output styles via resource API", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const response = await fetch(`${baseUrl}/output-styles`, { headers: auth(token) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        styles: [{ name: "default", content: "std", source: "builtin" }],
      });
    }, {
      outputStyleService: {
        list() {
          return [{ name: "default", content: "std", source: "builtin" as const }];
        },
      },
    });
  });

  it("exposes project/plugin/hooks/git/task-create resource APIs", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const init = await fetch(`${baseUrl}/project/init`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ cwd: process.cwd() }),
      });
      expect(init.status).toBe(200);
      expect(await init.json()).toEqual({ report: "INIT OK" });

      const plugins = await fetch(`${baseUrl}/plugins?cwd=${encodeURIComponent(process.cwd())}`, {
        headers: auth(token),
      });
      expect(plugins.status).toBe(200);
      expect(await plugins.json()).toEqual({
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

      const enable = await fetch(`${baseUrl}/plugins/demo/enable`, {
        method: "POST",
        headers: auth(token),
      });
      expect(enable.status).toBe(200);
      expect(await enable.json()).toEqual({ message: "Enabled plugin 'demo'." });

      const personas = await fetch(`${baseUrl}/agent-personas`, { headers: auth(token) });
      expect(personas.status).toBe(200);
      expect(await personas.json()).toEqual({
        agents: [{ name: "Explore", description: "search", source: "builtin" }],
      });

      const hooks = await fetch(
        `${baseUrl}/hooks?cwd=${encodeURIComponent(process.cwd())}`,
        { headers: auth(token) },
      );
      expect(hooks.status).toBe(200);
      expect(await hooks.json()).toEqual({
        hooks: [{
          id: "h1",
          event: "stop",
          type: "command",
          enabled: true,
          origin: "settings",
        }],
      });

      const diff = await fetch(
        `${baseUrl}/git/diff?cwd=${encodeURIComponent(process.cwd())}`,
        { headers: auth(token) },
      );
      expect(diff.status).toBe(200);
      expect(await diff.json()).toEqual({ output: "a.txt | 1 +\n" });

      const branch = await fetch(
        `${baseUrl}/git/branch?cwd=${encodeURIComponent(process.cwd())}&list=true`,
        { headers: auth(token) },
      );
      expect(branch.status).toBe(200);
      expect(await branch.json()).toEqual({ output: "* main\n" });

      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s-task", cwd: process.cwd(), model: "m" }),
      });
      const created = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "s-task",
          command: `${process.execPath} -e "process.exit(0)"`,
        }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as { task: { id: string; status: string; command?: string } };
      expect(createdBody.task.id).toMatch(/^task_/);
      expect(createdBody.task.command).toContain("process.exit(0)");
    }, {
      projectInitService: {
        async init() {
          return { report: "INIT OK" };
        },
      },
      pluginService: {
        async list() {
          return {
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
          };
        },
        async setEnabled({ name, enabled }) {
          return { message: `${enabled ? "Enabled" : "Disabled"} plugin '${name}'.` };
        },
      },
      agentPersonaService: {
        async list() {
          return { agents: [{ name: "Explore", description: "search", source: "builtin" }] };
        },
      },
      hooksService: {
        async list() {
          return {
            hooks: [{
              id: "h1",
              event: "stop",
              type: "command",
              enabled: true,
              origin: "settings" as const,
            }],
          };
        },
      },
      gitService: {
        async diff() {
          return { output: "a.txt | 1 +\n" };
        },
        async branch() {
          return { output: "* main\n" };
        },
        async status() {
          return { output: " M a.txt\n" };
        },
        async commit({ message }) {
          return { output: `[main abc] ${message}` };
        },
      },
    });

    await withServer(async ({ baseUrl, token }) => {
      const status = await fetch(
        `${baseUrl}/git/status?cwd=${encodeURIComponent(process.cwd())}`,
        { headers: auth(token) },
      );
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ output: " M a.txt\n" });

      const commit = await fetch(`${baseUrl}/git/commit`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ cwd: process.cwd(), message: "fix auth" }),
      });
      expect(commit.status).toBe(200);
      expect(await commit.json()).toEqual({ output: "[main abc] fix auth" });

      const reload = await fetch(`${baseUrl}/plugins/reload`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ cwd: process.cwd() }),
      });
      expect(reload.status).toBe(200);
      const reloadBody = await reload.json() as { message: string; plugins: unknown[] };
      expect(reloadBody.message).toContain("rediscovered");
      expect(reloadBody.plugins).toHaveLength(1);
    }, {
      pluginService: {
        async list() {
          return {
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
          };
        },
        async setEnabled() {
          return { message: "ok" };
        },
      },
      gitService: {
        async diff() {
          return { output: "" };
        },
        async branch() {
          return { output: "" };
        },
        async status() {
          return { output: " M a.txt\n" };
        },
        async commit({ message }) {
          return { output: `[main abc] ${message}` };
        },
      },
    });
  });

  it("rewinds a session transcript via store replace", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt() {
            return { messages: [] };
          },
          async close() {},
          async compact() {
            return {
              messageCount: 2,
              transcript: [
                {
                  role: "user",
                  parts: [{ type: "text", status: "completed", text: "hello" }],
                },
                {
                  role: "assistant",
                  parts: [{ type: "text", status: "completed", text: "hi" }],
                },
              ],
            };
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
      const empty = await fetch(`${baseUrl}/sessions/s1/rewind`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ count: 1 }),
      });
      expect(empty.status).toBe(400);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await fetch(`${baseUrl}/sessions/s1/compact`, {
        method: "POST",
        headers: auth(token),
      });
      const response = await fetch(`${baseUrl}/sessions/s1/rewind`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ count: 1 }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        turns: number;
        removed: number;
        messages: unknown[];
      };
      expect(body.turns).toBe(1);
      expect(body.removed).toBe(2);
      expect(body.messages).toHaveLength(0);
      const events = await (await fetch(`${baseUrl}/events`, { headers: auth(token) })).json() as {
        events: Array<{ type: string }>;
      };
      expect(
        events.events.map((event) => event.type).filter((type) => type === "session.transcript.replaced").length,
      ).toBeGreaterThanOrEqual(2);
    }, { runtimeFactory });
  });

  it("starts dream and manages profile via resource APIs", async () => {
    await withServer(async ({ baseUrl, token }) => {
      const dream = await fetch(`${baseUrl}/dream`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ cwd: process.cwd(), preview: true }),
      });
      expect(dream.status).toBe(201);
      expect(await dream.json()).toEqual({ taskId: "dream_1" });

      const status = await fetch(`${baseUrl}/profile`, { headers: auth(token) });
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ report: "PROFILE STATUS" });

      const init = await fetch(`${baseUrl}/profile/init`, {
        method: "POST",
        headers: auth(token),
      });
      expect(init.status).toBe(200);
      expect(await init.json()).toEqual({ report: "PROFILE INIT" });
    }, {
      dreamService: {
        async start() {
          return { started: true, taskId: "dream_1" };
        },
      },
      profileService: {
        async status() {
          return { report: "PROFILE STATUS" };
        },
        async init() {
          return { report: "PROFILE INIT" };
        },
      },
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

  it("hides child sessions from the default session list", async () => {
    await withServer(async ({ baseUrl, token }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "parent", cwd: process.cwd(), model: "m", title: "Parent" }),
      });
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "child", parentId: "parent", cwd: process.cwd(), model: "m", title: "Child" }),
      });

      const listed = await (await fetch(`${baseUrl}/sessions`, { headers: auth(token) })).json() as {
        sessions: Array<{ id: string }>;
      };
      expect(listed.sessions.map((session) => session.id)).toEqual(["parent"]);

      const withChildren = await (await fetch(`${baseUrl}/sessions?includeChildren=true`, {
        headers: auth(token),
      })).json() as {
        sessions: Array<{ id: string }>;
      };
      expect(withChildren.sessions.map((session) => session.id).sort()).toEqual(["child", "parent"]);
    });
  });

  it("archives descendants after interrupting runs and closing runtimes", async () => {
    let host: ChildSessionHost | undefined;
    let serverRef: OpenHarnessHttpServer | undefined;
    const lifecycle: string[] = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime(context) {
        host = context.childSessionHost;
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", () => {
                lifecycle.push(`interrupt:${input.session.id}`);
                resolve();
              }, { once: true });
            });
            throw new Error("interrupted by archive");
          },
          async close() {
            lifecycle.push(`close:${context.session.id}:${serverRef?.store.getSession(context.session.id)?.status}`);
          },
        };
      },
    };

    await withServer(async ({ baseUrl, token, server }) => {
      serverRef = server;
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "parent", cwd: process.cwd(), model: "m" }),
      });
      for (let i = 0; i < 20 && !host; i++) await new Promise((resolve) => setTimeout(resolve, 10));

      await host!.createChildSession({
        id: "child",
        parentId: "parent",
        cwd: process.cwd(),
        title: "child",
        agent: "Explore",
      });
      await host!.createChildSession({
        id: "grandchild",
        parentId: "child",
        cwd: process.cwd(),
        title: "grandchild",
        agent: "Explore",
      });
      await host!.admitPrompt("child", "run child");
      await host!.admitPrompt("grandchild", "run grandchild");
      for (let i = 0; i < 50; i++) {
        const running = ["child", "grandchild"].every((id) =>
          server.store.listRuns(id).some((run) => run.status === "running")
        );
        if (running) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const archived = await fetch(`${baseUrl}/sessions/parent`, {
        method: "DELETE",
        headers: auth(token),
      });

      expect(archived.status).toBe(200);
      expect(server.store.getSession("parent")?.status).toBe("archived");
      expect(server.store.getSession("child")?.status).toBe("archived");
      expect(server.store.getSession("grandchild")?.status).toBe("archived");
      for (const id of ["child", "grandchild"]) {
        const interruptIndex = lifecycle.indexOf(`interrupt:${id}`);
        const closeIndex = lifecycle.findIndex((event) => event.startsWith(`close:${id}:`));
        expect(interruptIndex).toBeGreaterThanOrEqual(0);
        expect(interruptIndex).toBeLessThan(closeIndex);
        expect(lifecycle[closeIndex]).not.toBe(`close:${id}:archived`);
      }
      expect(lifecycle.find((event) => event.startsWith("close:parent:"))).not.toBe("close:parent:archived");
    }, { runtimeFactory });
  });

  it("makes archive terminal before waiting for an interrupted run to settle", async () => {
    const abortObserved = deferred();
    const releaseRun = deferred();
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", () => {
                abortObserved.resolve();
                void releaseRun.promise.then(resolve);
              }, { once: true });
            });
            throw new Error("interrupted by archive");
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token, server }) => {
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

      const archive = fetch(`${baseUrl}/sessions/s1`, { method: "DELETE", headers: auth(token) });
      await abortObserved.promise;
      expect(server.store.getSession("s1")?.status).toBe("closing");

      const rejected = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "must not run" }),
      });
      expect(rejected.status).toBe(409);

      releaseRun.resolve();
      expect((await archive).status).toBe(200);
      expect(server.store.getSession("s1")?.status).toBe("archived");
      expect(server.store.listInputs("s1").map((input) => input.content)).toEqual(["active"]);
    }, { runtimeFactory });
  });

  it("returns the original admission for an idempotent prompt retry", async () => {
    await withServer(async ({ baseUrl, token, server }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });
      const request = {
        id: "prompt-request-1",
        content: "do the thing",
        metadata: { source: "tui", labels: ["retry"] },
      };
      const first = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const second = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const firstBody = await first.json() as { input: { id: string } };
      const secondBody = await second.json() as { input: { id: string } };
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(secondBody.input.id).toBe(firstBody.input.id);
      expect(server.store.listInputs("s1")).toHaveLength(1);

      const conflict = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ ...request, content: "a different operation" }),
      });
      expect(conflict.status).toBe(409);
      expect(server.store.listInputs("s1")).toHaveLength(1);
    });
  });

  it("keeps a session running while only queued work is interrupted", async () => {
    const abortObserved = deferred();
    const releaseRun = deferred();
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", () => {
                abortObserved.resolve();
                void releaseRun.promise.then(resolve);
              }, { once: true });
            });
            throw new Error("interrupted by test");
          },
          async close() {},
        };
      },
    };

    await withServer(async ({ baseUrl, token, server }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m" }),
      });
      for (const content of ["active", "queued"]) {
        await fetch(`${baseUrl}/sessions/s1/prompts`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
      }
      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "running",
      );

      await fetch(`${baseUrl}/sessions/s1/interrupt`, { method: "POST", headers: auth(token) });
      await abortObserved.promise;
      expect(server.store.getSession("s1")?.status).toBe("running");

      releaseRun.resolve();
      for (let i = 0; i < 50 && server.store.getSession("s1")?.status !== "idle"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(server.store.getSession("s1")?.status).toBe("idle");
    }, { runtimeFactory });
  });

  it("rejects runtime metadata changes while a run is active", async () => {
    const started = deferred();
    const closed: string[] = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime(context) {
        return {
          async runPrompt() {
            started.resolve();
            await new Promise<void>(() => {});
            return { messages: [] };
          },
          async close() {
            closed.push(context.session.id);
          },
        };
      },
    };

    await withServer(async ({ baseUrl, token, server }) => {
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd: process.cwd(), model: "m", metadata: { permissionMode: "default" } }),
      });
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "active" }),
      });
      await started.promise;

      const patched = await fetch(`${baseUrl}/sessions/s1`, {
        method: "PATCH",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ metadata: { permissionMode: "plan" } }),
      });
      expect(patched.status).toBe(409);
      expect(server.store.getSession("s1")?.metadata.permissionMode).toBe("default");
      expect(closed).toEqual([]);
    }, { runtimeFactory });
  });

  it("rejects runtime-restarting resource mutations before they write state", async () => {
    const started = deferred();
    const stopped = deferred();
    const closed: string[] = [];
    let memoryWrites = 0;
    let authWrites = 0;
    let pluginWrites = 0;
    let profileWrites = 0;
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime(context) {
        return {
          async runPrompt(input) {
            started.resolve();
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", resolve, { once: true });
            });
            stopped.resolve();
            throw input.signal.reason;
          },
          async close() {
            closed.push(context.session.id);
          },
          async remember() {
            return { skipped: false, writtenIds: [], titles: [] };
          },
        };
      },
    };

    await withServer(async ({ baseUrl, token }) => {
      const cwd = process.cwd();
      await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ id: "s1", cwd, model: "m" }),
      });
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "active" }),
      });
      await started.promise;

      const requests = await Promise.all([
        fetch(`${baseUrl}/memory`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd, content: "do not persist" }),
        }),
        fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
        }),
        fetch(`${baseUrl}/profile/init`, { method: "POST", headers: auth(token) }),
        fetch(`${baseUrl}/plugins/demo/enable`, { method: "POST", headers: auth(token) }),
        fetch(`${baseUrl}/plugins/reload`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ cwd }),
        }),
        fetch(`${baseUrl}/sessions/s1/remember`, { method: "POST", headers: auth(token) }),
      ]);

      expect(requests.map((response) => response.status)).toEqual([409, 409, 409, 409, 409, 409]);
      expect({ memoryWrites, authWrites, pluginWrites, profileWrites, closed }).toEqual({
        memoryWrites: 0,
        authWrites: 0,
        pluginWrites: 0,
        profileWrites: 0,
        closed: [],
      });

      await fetch(`${baseUrl}/sessions/s1/interrupt`, { method: "POST", headers: auth(token) });
      await stopped.promise;
    }, {
      runtimeFactory,
      memoryService: {
        async list() { return { directory: "/tmp/memory", entries: [] }; },
        async get() { return null; },
        async add() {
          memoryWrites++;
          return { id: "m1", content: "unexpected", createdAt: 1, updatedAt: 1 };
        },
        async remove() { return false; },
      },
      authService: {
        async status() {
          return { codex: { configured: false, state: "none", source: "none" }, storedProviders: [], envProviders: [] };
        },
        async login() { authWrites++; return { message: "unexpected" }; },
        async logout() { authWrites++; return { message: "unexpected" }; },
      },
      profileService: {
        async status() { return { report: "unused" }; },
        async init() { profileWrites++; return { report: "unexpected" }; },
      },
      pluginService: {
        async list() { return { plugins: [], warnings: [] }; },
        async setEnabled() { pluginWrites++; return { message: "unexpected", restartRuntimes: true }; },
      },
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

  it("replays a filtered SSE stream from Last-Event-ID", async () => {
    await withServer(async ({ baseUrl, token }) => {
      for (const id of ["s1", "s2"]) {
        await fetch(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { ...auth(token), "content-type": "application/json" },
          body: JSON.stringify({ id, cwd: process.cwd(), model: "m" }),
        });
      }
      await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "replay me" }),
      });

      const abort = new AbortController();
      const stream = await fetch(`${baseUrl}/events/stream?sessionId=s1`, {
        headers: { ...auth(token), "last-event-id": "1" },
        signal: abort.signal,
      });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (let i = 0; i < 10 && !text.includes("session.input.admitted"); i++) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel();
      abort.abort();

      expect(text).toContain("session.input.admitted");
      expect(text).toContain("id: 3\nevent: session.input.admitted");
      expect(text).not.toContain("id: 1\nevent:");
      expect(text).not.toContain('"sessionId":"s2"');
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

  it("steers into an active run without creating a second run", async () => {
    const release = deferred();
    let observedWakeCount = 0;
    let drained: Array<{ content: string; delivery: string }> = [];
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            for (let i = 0; i < 100; i++) {
              if (input.wakeCount() > 0) {
                observedWakeCount = input.wakeCount();
                drained = input.drainSteeredInputs();
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await release.promise;
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
        body: JSON.stringify({ content: "active" }),
      });
      const firstBody = await first.json() as {
        run: { id: string };
        queue_state: string;
      };
      expect(first.status).toBe(202);
      expect(firstBody.queue_state).toBe("running");

      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "running",
      );

      const steered = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "course correct", delivery: "steer" }),
      });
      const steeredBody = await steered.json() as {
        input: { content: string; delivery: string };
        run?: { id: string };
        queue_state?: string;
      };
      expect(steered.status).toBe(202);
      expect(steeredBody.input).toMatchObject({ content: "course correct", delivery: "steer" });
      expect(steeredBody.run?.id).toBe(firstBody.run.id);
      expect(steeredBody.queue_state).toBe("running");

      const state = await (await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })).json() as {
        runs: Array<{ id: string }>;
        inputs: Array<{ content: string; delivery: string }>;
      };
      expect(state.runs).toHaveLength(1);
      expect(state.inputs.map((input) => [input.content, input.delivery])).toEqual([
        ["active", "queue"],
        ["course correct", "steer"],
      ]);

      for (let i = 0; i < 50 && observedWakeCount === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedWakeCount).toBeGreaterThan(0);
      expect(drained.map((input) => [input.content, input.delivery])).toEqual([
        ["course correct", "steer"],
      ]);

      release.resolve();
      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "completed",
      );
    }, { runtimeFactory });
  });

  it("falls back to creating a run when steer arrives while idle", async () => {
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt() {},
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

      const steered = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "start via steer", delivery: "steer" }),
      });
      const body = await steered.json() as {
        run: { id: string };
        queue_state: string;
        input: { delivery: string };
      };
      expect(steered.status).toBe(202);
      expect(body.input.delivery).toBe("steer");
      expect(body.run.id).toEqual(expect.any(String));
      expect(body.queue_state).toBe("running");

      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "completed",
      );

      const state = await (await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })).json() as {
        runs: Array<{ id: string }>;
      };
      expect(state.runs).toHaveLength(1);
    }, { runtimeFactory });
  });

  it("keeps queue delivery enqueue semantics while a run is active", async () => {
    const release = deferred();
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime() {
        return {
          async runPrompt(input) {
            await new Promise<void>((resolve) => {
              const finish = () => resolve();
              input.signal.addEventListener("abort", finish, { once: true });
              void release.promise.then(finish);
            });
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
        body: JSON.stringify({ content: "active" }),
      });
      const firstBody = await first.json() as { run: { id: string } };

      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { status?: string } | undefined)?.status === "running",
      );

      const queued = await fetch(`${baseUrl}/sessions/s1/prompts`, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ content: "next", delivery: "queue" }),
      });
      const queuedBody = await queued.json() as {
        run: { id: string };
        queue_state: string;
      };
      expect(queued.status).toBe(202);
      expect(queuedBody.run.id).not.toBe(firstBody.run.id);
      expect(queuedBody.queue_state).toBe("queued");

      const state = await (await fetch(`${baseUrl}/sessions/s1/state`, { headers: auth(token) })).json() as {
        runs: Array<{ id: string }>;
      };
      expect(state.runs).toHaveLength(2);

      release.resolve();
      await waitForEvent(baseUrl, token, (event) =>
        event.type === "session.run.updated" &&
        (event.payload?.run as { id?: string; status?: string } | undefined)?.id === queuedBody.run.id &&
        (event.payload?.run as { status?: string } | undefined)?.status === "completed",
      );
    }, { runtimeFactory });
  });
});
