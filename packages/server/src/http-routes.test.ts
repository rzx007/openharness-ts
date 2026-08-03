import { describe, expect, it, vi } from "vitest";

import { createAuthRoutes } from "./http-auth-routes.js";
import { createGitRoutes } from "./http-git-routes.js";
import { createMemoryRoutes } from "./http-memory-routes.js";
import { createPermissionRoutes } from "./http-permission-routes.js";
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
