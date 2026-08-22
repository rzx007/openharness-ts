import { describe, expect, it, vi } from "vitest";

import { createAuthRoutes } from "../auth.js";
import { HttpEventHub } from "../events.js";
import { createGitRoutes } from "../git.js";
import { createMemoryRoutes } from "../memory.js";
import { createPermissionRoutes } from "../permission.js";
import { createRunExecutionRoutes } from "../run-execution.js";
import { createScheduleRoutes } from "../schedules.js";
import { createServiceRoutes } from "../service.js";
import { createSessionRoutes } from "../session.js";
import { createSessionUtilityRoutes } from "../session-utility.js";
import { createSystemRoutes } from "../system.js";
import { SessionApplicationError } from "../../../application/session/session-application-service.js";

function runtimeSnapshot() {
  return {
    startedAt: 100,
    uptimeMs: 25,
    sessions: { total: 2, byStatus: { active: 2 } },
    runs: { total: 1, byStatus: { completed: 1 } },
    tasks: { total: 0, byStatus: {} },
    permissions: { total: 0, byStatus: {} },
    projectionSettlements: { total: 0, pending: 0, byStatus: {} },
    sseClientCount: 0,
    warmAgentCount: 1,
    coordinator: { activeRunCount: 1, queuedRunCount: 3 },
    metrics: { counters: {}, gauges: {}, histograms: {} },
  };
}

function daemonControl(overrides: Record<string, unknown> = {}) {
  return {
    runtimeSnapshot,
    acquireGlobalMutation: () => ({ release() {} }),
    acquireCwdMutation: () => ({ release() {} }),
    closeAllRuntimes: async () => {},
    closeRuntimesForCwd: async () => {},
    runtimeInspectionAvailable: true,
    sessionExists: () => true,
    inspectRuntimeHooks: async () => [],
    inspectRun: () => undefined,
    listProjectionDiagnostics: () => ({ settlements: [], pending: 0, diagnosticOk: true, includeContent: false }),
    ...overrides,
  };
}

describe("Scheduled task routes", () => {
  it("creates Agent schedules and lists their runs", async () => {
    const task = {
      id: "schedule-1",
      name: "weekday-review",
      prompt: "Review changes",
      recurrence: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      recurrenceFormat: "rrule" as const,
      timezone: "Asia/Shanghai",
      status: "active" as const,
      destination: "standalone" as const,
      projectPaths: ["/repo"],
      executionMode: "local" as const,
      skillNames: [],
      pluginNames: [],
      permissionProfile: { mode: "workspace_write" as const },
      overlapPolicy: "skip" as const,
      missedRunPolicy: "skip" as const,
      createdBy: "user" as const,
      runCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const createTask = vi.fn(() => task);
    const app = createScheduleRoutes({
      schedules: {
        createTask,
        getTask: vi.fn(() => task),
        listTasks: vi.fn(() => [task]),
        updateTask: vi.fn(() => task),
        removeTask: vi.fn(),
        trigger: vi.fn(),
        listRuns: vi.fn(() => []),
        markRunRead: vi.fn(),
        status: vi.fn(() => ({
          running: true,
          tasks: 1,
          active: 1,
          paused: 0,
          executing: 0,
          unread: 0,
        })),
      },
    });

    const response = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: task.name,
        prompt: task.prompt,
        recurrence: task.recurrence,
        recurrenceFormat: task.recurrenceFormat,
        timezone: task.timezone,
        destination: task.destination,
        projectPaths: task.projectPaths,
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ task });
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Review changes" }),
    );
    await expect(
      (await app.request("/runs?taskId=schedule-1&unread=true&limit=5")).json(),
    ).resolves.toEqual({ runs: [] });
  });
});

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
    const body = (await response.json()) as {
      commands: Array<{ name: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.commands.some((command) => command.name === "/custom")).toBe(
      true,
    );
    expect(body.commands.some((command) => command.name === "/model")).toBe(
      false,
    );
  });

  it("lists connected model providers", async () => {
    const app = createSystemRoutes({
      control: daemonControl(),
      modelService: {
        list: () => [
          {
            name: "deepseek",
            displayName: "DeepSeek",
            models: [
              {
                id: "deepseek-chat",
                label: "DeepSeek Chat",
                provider: "DeepSeek",
                providerName: "deepseek",
              },
            ],
          },
        ],
      },
    });

    const response = await app.request("/models");
    const body = (await response.json()) as {
      providers: Array<{ name: string; models: Array<{ id: string }> }>;
    };

    expect(response.status).toBe(200);
    expect(body.providers).toEqual([
      {
        name: "deepseek",
        displayName: "DeepSeek",
        models: [
          {
            id: "deepseek-chat",
            label: "DeepSeek Chat",
            provider: "DeepSeek",
            providerName: "deepseek",
          },
        ],
      },
    ]);
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
      body: JSON.stringify({
        cwd: "/repo",
        content: "Remember this",
        tags: ["a"],
      }),
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
      control: daemonControl({ acquireGlobalMutation: () => undefined }),
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
  it("serves context status", async () => {
    const app = createServiceRoutes({
      contextService: {
        preview: async () => ({ report: "preview" }),
        status: async () => ({ report: "status table" }),
      },
      control: daemonControl(),
    });

    const response = await app.request("/context/status?cwd=/repo");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ report: "status table" });
  });

  it("blocks plugin reload while runs are active for the cwd", async () => {
    const app = createServiceRoutes({
      pluginService: {
        list: async () => ({ plugins: [], warnings: [] }),
        setEnabled: async () => ({ message: "ok" }),
      },
      control: daemonControl({ acquireCwdMutation: () => undefined }),
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
    await expect(response.json()).resolves.toEqual({
      error: "cwd is required",
    });
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
      body: JSON.stringify({
        status: "approved",
        decision: "once",
        clientId: "desk",
      }),
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
        deleteSessionTree: vi.fn(),
        forkSession: vi.fn(),
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
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", cwd: "/repo" }),
    );
  });

  it("forks a session after a selected message", async () => {
    const fork = {
      id: "fork-1",
      parentId: "s1",
      cwd: "/repo",
      title: "Session fork",
      model: "gpt-test",
      status: "idle",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const forkSession = vi.fn(() => fork);
    const app = createSessionRoutes({
      queries: {
        getSession: vi.fn(),
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
        deleteSessionTree: vi.fn(),
        forkSession,
        admitPrompt: vi.fn(),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/fork", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ afterMessageId: "m2" }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ session: fork });
    expect(forkSession).toHaveBeenCalledWith("s1", {
      afterMessageId: "m2",
    });
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
        deleteSessionTree: vi.fn(),
        forkSession: vi.fn(),
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

  it("preserves application error status for slash command prompts", async () => {
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
        deleteSessionTree: vi.fn(),
        forkSession: vi.fn(),
        admitPrompt: vi.fn(async () => {
          throw new SessionApplicationError(500, "Child projection mismatch");
        }),
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

    expect(response.status).toBe(500);
  });

  it("hard deletes a session through the explicit hard-delete route", async () => {
    const deleteSessionTree = vi.fn(async () => ["child", "parent"]);
    const app = createSessionRoutes({
      queries: {
        getSession: vi.fn(),
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
        deleteSessionTree,
        forkSession: vi.fn(),
        admitPrompt: vi.fn(),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/parent/hard", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deletedSessionIds: ["child", "parent"],
    });
    expect(deleteSessionTree).toHaveBeenCalledWith("parent");
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
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession: vi.fn(() => ({
          interrupted: false,
          queuedRunIds: [],
        })),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "i1",
        delivery: "steer",
        content: "hello",
        metadata: { source: "test" },
      }),
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

  it("preserves session application error status for prompt failures", async () => {
    const app = createRunExecutionRoutes({
      application: {
        admitPrompt: vi.fn(async () => {
          throw new SessionApplicationError(500, "projection mismatch");
        }),
        editLatestPrompt: vi.fn(),
        resumeRun: vi.fn(),
        interruptSession: vi.fn(() => ({
          interrupted: false,
          queuedRunIds: [],
        })),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(response.status).toBe(500);
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
        editLatestPrompt: vi.fn(),
        resumeRun,
        interruptSession: vi.fn(() => ({
          interrupted: false,
          queuedRunIds: [],
        })),
      },
      traces: { get: () => "trace-1" },
    });

    const response = await app.request("/s1/runs/source-run/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "recovery-input",
        metadata: { requestedBy: "test" },
      }),
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
    const rewind = vi.fn(async () => ({
      turns: 2,
      removed: 4,
      messages: [],
      parts: [],
    }));
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

describe("event routes", () => {
  it("lists events with cursor, session, and limit filters", async () => {
    const listEvents = vi.fn(() => [
      {
        id: "e1",
        seq: 2,
        type: "session.updated",
        sessionId: "s1",
        payload: {},
        createdAt: 1,
      },
    ]);
    const hub = new HttpEventHub({ listEvents });

    const response = await hub
      .createRoutes()
      .request("/?cursor=1&sessionId=s1&limit=5");

    expect(response.status).toBe(200);
    expect(listEvents).toHaveBeenCalledWith({
      afterSeq: 1,
      sessionId: "s1",
      limit: 5,
    });
    await expect(response.json()).resolves.toEqual({
      events: [
        {
          id: "e1",
          seq: 2,
          type: "session.updated",
          sessionId: "s1",
          payload: {},
          createdAt: 1,
        },
      ],
    });
  });
});
