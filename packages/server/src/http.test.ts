import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandCatalogProvider } from "./commands.js";
import { OpenHarnessHttpServer } from "./http.js";
import { getDefaultSessionStorePath } from "./paths.js";
import type { SessionRuntimeFactory } from "./runtime.js";
import type { OpenHarnessServerOptions } from "./http.js";

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
  > = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohs-server-"));
  const token = "test-token";
  const server = new OpenHarnessHttpServer({
    token,
    storePath: join(dir, "sessions.json"),
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
  });
  const listen = await server.listen();
  try {
    await test({ baseUrl: listen.url, token, storePath: join(dir, "sessions.json"), server });
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
    };
    let host: Host | undefined;
    const runtimeFactory: SessionRuntimeFactory = {
      async createRuntime(context) {
        host = (context as typeof context & { childSessionHost?: Host }).childSessionHost;
        return {
          async runPrompt(_input, hooks) {
            await hooks.onStreamEvent({ type: "text_delta", delta: "child output" });
            return { messages: [] };
          },
          async close() {},
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
      await expect(host!.awaitRun(child.id, admitted.runId!)).resolves.toMatchObject({
        status: "completed",
        output: "child output",
      });
    }, { runtimeFactory });
  });

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

  it("reloads sessions/messages/events after a daemon restart and interrupts leftover runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-server-restart-"));
    const storePath = join(dir, "sessions.json");
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
        };
        expect(state.messages).toHaveLength(1);
        expect(state.parts[0]?.text).toBe("survived restart");
        expect(state.runs.find((run) => run.id === "r-stale")?.status).toBe("interrupted");

        const events = await (await fetch(`${listen2.url}/events`, { headers: auth(token) })).json() as {
          events: Array<{ type: string }>;
        };
        expect(events.events.map((event) => event.type)).toContain("session.transcript.replaced");
        expect(events.events.map((event) => event.type)).toContain("session.run.updated");
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
