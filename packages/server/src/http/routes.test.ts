import { describe, expect, it, vi } from "vitest";

import { createAuthRoutes } from "./routes/auth.js";
import { HttpEventHub } from "./routes/events.js";
import { createGitRoutes } from "./routes/git.js";
import { createMemoryRoutes } from "./routes/memory.js";
import { createPermissionRoutes } from "./routes/permission.js";
import { createRunExecutionRoutes } from "./routes/run-execution.js";
import { createServiceRoutes } from "./routes/service.js";
import { createSessionRoutes } from "./routes/session.js";
import { createSessionUtilityRoutes } from "./routes/session-utility.js";
import { createSystemRoutes } from "./routes/system.js";
import { createTaskRoutes } from "./routes/task.js";

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

function daemonControl(overrides: Record<string, unknown> = {}) {
  return {
    runtimeSnapshot,
    hasAnyActiveRuns: () => false,
    hasActiveRunsForCwd: () => false,
    closeAllRuntimes: async () => {},
    closeRuntimesForCwd: async () => {},
    runtimeInspectionAvailable: true,
    sessionExists: () => true,
    inspectRuntimeHooks: async () => [],
    ...overrides,
  };
}

describe("system routes", () => {
  it("serves health from the runtime snapshot", async () => {
    const app = createSystemRoutes({
      version: "1.2.3",
      control: daemonControl(),
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
      control: daemonControl(),
      commandCatalog: {
        list: () => [{ name: "/custom", kind: "template", source: "project" }],
      },
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
      control: daemonControl({ closeRuntimesForCwd }),
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
      control: daemonControl({ hasAnyActiveRuns: () => true }),
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
      control: daemonControl({ hasActiveRunsForCwd: () => true }),
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
      permissions: { listRequests: () => [], reply },
      traces: { get: () => "trace-1" },
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
    const createSession = vi.fn(() => session);
    const app = createSessionRoutes({
      queries: {
        getSession: vi.fn(),
        getSessionState: vi.fn(),
        listMessageParts: vi.fn(() => []),
        listMessages: vi.fn(() => []),
        listSessions: vi.fn(() => []),
      },
      application: {
        createSession,
        getSession: vi.fn(),
        updateSession: vi.fn(),
        archiveSessionTree: vi.fn(async () => session),
        admitPrompt: vi.fn(),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s1", cwd: "/repo", model: "gpt-test" }),
    });

    expect(response.status).toBe(201);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", cwd: "/repo" }));
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
      queries: {
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
      },
      application: {
        createSession: vi.fn(),
        getSession: vi.fn(),
        updateSession: vi.fn(),
        archiveSessionTree: vi.fn(),
        admitPrompt: admitPromptAndMaybeRun,
      },
      commandCatalog: {
        expand: vi.fn(async () => ({
          prompt: "expanded prompt",
          command: { name: "/fix", kind: "template", source: "project" },
        })),
      },
      traces: { get: () => "trace-1" },
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
      application: {
        admitPrompt: admitPromptAndMaybeRun,
        resumeRun: vi.fn(),
        interruptSession: vi.fn(() => ({ interrupted: false, queuedRunIds: [] })),
      },
      traces: { get: () => "trace-1" },
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

  it("forwards interrupted-run recovery to the session application", async () => {
    const resumeRun = vi.fn(() => ({
      input: { id: "recovery-input" },
      run: { id: "recovery-run" },
      source_run: { id: "source-run", status: "interrupted" },
    }));
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(),
        resumeRun,
        interruptSession: vi.fn(() => ({ interrupted: false, queuedRunIds: [] })),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/runs/source-run/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "recovery-input", metadata: { requestedBy: "test" } }),
    });

    expect(response.status).toBe(202);
    expect(resumeRun).toHaveBeenCalledWith("s1", "source-run", {
      id: "recovery-input",
      metadata: { requestedBy: "test" },
      traceId: "trace-1",
    });
  });
});

describe("session utility routes", () => {
  it("forwards rewind parameters to session maintenance", async () => {
    const rewind = vi.fn(async () => ({ turns: 2, removed: 4, messages: [], parts: [] }));
    const app = createSessionUtilityRoutes({
      maintenance: {
        listMcpServers: vi.fn(),
        getUsage: vi.fn(),
        exportSession: vi.fn(),
        compact: vi.fn(),
        rewind,
        remember: vi.fn(),
      },
    });

    const response = await app.request("/s1/rewind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });

    expect(response.status).toBe(200);
    expect(rewind).toHaveBeenCalledWith("s1", 2);
  });
});

describe("task routes", () => {
  it("forwards shell task creation to the task service", async () => {
    const create = vi.fn(async () => ({ task: { id: "task-1", status: "running" } }));
    const app = createTaskRoutes({
      tasks: {
        list: vi.fn(),
        create,
        get: vi.fn(),
        stop: vi.fn(),
      },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", command: "pnpm test" }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      cwd: undefined,
      sessionId: "s1",
      command: "pnpm test",
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
