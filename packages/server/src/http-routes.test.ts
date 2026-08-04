import { describe, expect, it, vi } from "vitest";

import { createAuthRoutes } from "./http-auth-routes.js";
import { createGitRoutes } from "./http-git-routes.js";
import { HttpEventHub } from "./http-events-routes.js";
import { createMemoryRoutes } from "./http-memory-routes.js";
import { createPermissionRoutes } from "./http-permission-routes.js";
import { createRunExecutionRoutes } from "./http-run-execution-routes.js";
import { createSessionRoutes } from "./http-session-routes.js";
import { createServiceRoutes } from "./http-service-routes.js";
import { createSystemRoutes } from "./http-system-routes.js";

function runtimeSnapshot() {
  return {
    startedAt: 100,
    uptimeMs: 25,
    sessions: { total: 2, byStatus: { active: 2 } },
    runs: { total: 1, byStatus: { completed: 1 } },
    tasks: { total: 0, byStatus: {} },
    permissions: { total: 0, byStatus: {} },
    sseClientCount: 0,
    warmRuntimeCount: 1,
    coordinator: { activeRunCount: 1, queuedRunCount: 3 },
  };
}

describe("system routes", () => {
  it("serves health from the runtime snapshot", async () => {
    const app = createSystemRoutes({
      version: "1.2.3",
      runtimeSnapshot,
      hasAnyActiveRuns: () => false,
      closeAllRuntimes: async () => {},
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      version: "1.2.3",
      sessionCount: 2,
      activeRunCount: 1,
      queuedRunCount: 3,
    });
  });

  it("lists built-in and provider commands", async () => {
    const app = createSystemRoutes({
      runtimeSnapshot,
      commandCatalog: {
        list: () => [{ name: "/custom", kind: "template", source: "project" }],
      },
      hasAnyActiveRuns: () => false,
      closeAllRuntimes: async () => {},
    });

    const response = await app.request("/commands?cwd=/repo");
    const body = await response.json() as { commands: Array<{ name: string }> };

    expect(response.status).toBe(200);
    expect(body.commands.some((command) => command.name === "/custom")).toBe(true);
    expect(body.commands.some((command) => command.name === "/model")).toBe(true);
  });
});

describe("memory routes", () => {
  it("adds memory and closes runtimes for the cwd", async () => {
    const closeRuntimesForCwd = vi.fn();
    const app = createMemoryRoutes({
      memoryService: {
        add: async (input) => ({ id: "m1", ...input }),
        list: async () => ({ entries: [] }),
        get: async () => undefined,
        remove: async () => false,
      },
      hasActiveRunsForCwd: () => false,
      closeRuntimesForCwd,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", content: "Remember this", tags: ["a"] }),
    });

    expect(response.status).toBe(201);
    expect(closeRuntimesForCwd).toHaveBeenCalledWith("/repo");
  });
});

describe("auth routes", () => {
  it("rejects login while runs are active", async () => {
    const app = createAuthRoutes({
      authService: {
        status: async () => ({ providers: [] }),
        login: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
      },
      hasAnyActiveRuns: () => true,
      closeAllRuntimes: async () => {},
    });

    const response = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Cannot update authentication while session runs are active",
    });
  });
});

describe("service routes", () => {
  it("blocks plugin reload while runs are active for the cwd", async () => {
    const app = createServiceRoutes({
      pluginService: {
        list: async () => ({ plugins: [], warnings: [] }),
        setEnabled: async () => ({ message: "ok" }),
      },
      hasAnyActiveRuns: () => false,
      hasActiveRunsForCwd: () => true,
      closeAllRuntimes: async () => {},
      closeRuntimesForCwd: async () => {},
    });

    const response = await app.request("/plugins/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/repo" }),
    });

    expect(response.status).toBe(409);
  });
});

describe("git routes", () => {
  it("requires cwd for git status", async () => {
    const app = createGitRoutes({
      gitService: {
        diff: async () => ({ output: "" }),
        branch: async () => ({ output: "" }),
        status: async () => ({ output: "" }),
        commit: async () => ({ output: "" }),
      },
    });

    const response = await app.request("/status");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "cwd is required" });
  });
});

describe("permission routes", () => {
  it("passes trace id through permission replies", async () => {
    const reply = vi.fn(() => ({ id: "p1", status: "approved" }));
    const app = createPermissionRoutes({
      listRequests: () => [],
      reply,
      traceIdForRequest: () => "trace-1",
    });

    const response = await app.request("/p1/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", decision: "once", clientId: "desk" }),
    });

    expect(response.status).toBe(200);
    expect(reply).toHaveBeenCalledWith({
      requestId: "p1",
      traceId: "trace-1",
      status: "approved",
      decision: "once",
      clientId: "desk",
    });
  });
});

describe("session routes", () => {
  it("creates sessions and warms their runtime", async () => {
    const warmRuntime = vi.fn(async () => {});
    const broadcastSince = vi.fn();
    const session = {
      id: "s1",
      cwd: "/repo",
      title: "New session",
      model: "gpt-test",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const app = createSessionRoutes({
      store: {
        createSession: vi.fn(() => session),
        getSession: vi.fn(),
        getSessionState: vi.fn(),
        listMessageParts: vi.fn(() => []),
        listMessages: vi.fn(() => []),
        listSessions: vi.fn(() => []),
        resolveSessionListTitle: vi.fn(),
        updateSession: vi.fn(),
      },
      latestEventSeq: () => 7,
      broadcastSince,
      warmRuntime,
      hasRunWork: () => false,
      closeRuntime: async () => {},
      archiveSessionTree: async () => session,
      traceIdForRequest: () => "trace-1",
      admitPromptAndMaybeRun: vi.fn(),
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s1", cwd: "/repo", model: "gpt-test" }),
    });

    expect(response.status).toBe(201);
    expect(warmRuntime).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("expands slash commands into admitted prompts", async () => {
    const admitPromptAndMaybeRun = vi.fn(() => ({
      input: {
        id: "i1",
        sessionId: "s1",
        seq: 1,
        delivery: "queue",
        content: "expanded prompt",
        metadata: {},
        createdAt: 1,
      },
    }));
    const app = createSessionRoutes({
      store: {
        createSession: vi.fn(),
        getSession: vi.fn(() => ({
          id: "s1",
          cwd: "/repo",
          title: "Session",
          model: "gpt-test",
          status: "idle",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        })),
        getSessionState: vi.fn(),
        listMessageParts: vi.fn(() => []),
        listMessages: vi.fn(() => []),
        listSessions: vi.fn(() => []),
        resolveSessionListTitle: vi.fn(),
        updateSession: vi.fn(),
      },
      commandCatalog: {
        expand: vi.fn(async () => ({
          prompt: "expanded prompt",
          command: { name: "/fix", kind: "template", source: "project" },
        })),
      },
      latestEventSeq: () => 1,
      broadcastSince: vi.fn(),
      warmRuntime: async () => {},
      hasRunWork: () => false,
      closeRuntime: async () => {},
      archiveSessionTree: async () => {
        throw new Error("not used");
      },
      traceIdForRequest: () => "trace-1",
      admitPromptAndMaybeRun,
    });

    const response = await app.request("/s1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: "/fix tests" }),
    });

    expect(response.status).toBe(202);
    expect(admitPromptAndMaybeRun).toHaveBeenCalledWith("s1", {
      content: "expanded prompt",
      metadata: {
        command: "/fix",
        commandKind: "template",
        commandArgs: "tests",
      },
      traceId: "trace-1",
    });
  });
});

describe("run execution routes", () => {
  it("admits prompts with trace metadata", async () => {
    const admitPromptAndMaybeRun = vi.fn(() => ({
      input: {
        id: "i1",
        sessionId: "s1",
        seq: 1,
        delivery: "steer",
        content: "hello",
        metadata: {},
        createdAt: 1,
      },
    }));
    const app = createRunExecutionRoutes({
      store: {
        appendEvent: vi.fn(),
        findRunByInput: vi.fn(),
        getInput: vi.fn(),
        getRun: vi.fn(),
        listInputs: vi.fn(() => []),
      },
      hasRuntime: () => true,
      hasRunWork: () => false,
      latestEventSeq: () => 1,
      broadcastSince: vi.fn(),
      traceIdForRequest: () => "trace-1",
      admitPromptAndMaybeRun,
      interruptSession: vi.fn(() => ({ interrupted: false, queuedRunIds: [] })),
    });

    const response = await app.request("/s1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "i1", delivery: "steer", content: "hello", metadata: { source: "test" } }),
    });

    expect(response.status).toBe(202);
    expect(admitPromptAndMaybeRun).toHaveBeenCalledWith("s1", {
      id: "i1",
      delivery: "steer",
      content: "hello",
      metadata: { source: "test" },
      traceId: "trace-1",
    });
  });
});

describe("event routes", () => {
  it("lists events with cursor, session, and limit filters", async () => {
    const listEvents = vi.fn(() => [{
      id: "e1",
      seq: 2,
      type: "session.updated",
      sessionId: "s1",
      payload: {},
      createdAt: 1,
    }]);
    const hub = new HttpEventHub({ listEvents });

    const response = await hub.createRoutes().request("/?cursor=1&sessionId=s1&limit=5");

    expect(response.status).toBe(200);
    expect(listEvents).toHaveBeenCalledWith({ afterSeq: 1, sessionId: "s1", limit: 5 });
    await expect(response.json()).resolves.toEqual({
      events: [{
        id: "e1",
        seq: 2,
        type: "session.updated",
        sessionId: "s1",
        payload: {},
        createdAt: 1,
      }],
    });
  });
});
