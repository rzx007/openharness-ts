import { describe, expect, it, vi } from "vitest";
import { createServiceRoutes } from "./service.js";

function createPluginRoutes() {
  const release = vi.fn();
  const acquireGlobalMutation = vi.fn(() => ({ release }));
  const acquireCwdMutation = vi.fn(() => ({ release }));
  const closeAllRuntimes = vi.fn(async () => {});
  const closeRuntimesForCwd = vi.fn(async () => {});
  const pluginService = {
    async list() { return { plugins: [], warnings: [] }; },
    async setEnabled() { return { message: "updated", restartRuntimes: true }; },
    async installLocal() { return { message: "installed", restartRuntimes: true }; },
    async uninstall() { return { message: "uninstalled", restartRuntimes: true }; },
  };
  const routes = createServiceRoutes({
    pluginService,
    control: {
      acquireGlobalMutation,
      acquireCwdMutation,
      closeAllRuntimes,
      closeRuntimesForCwd,
      runtimeInspectionAvailable: false,
      async inspectRuntimeHooks() { return []; },
      sessionExists() { return false; },
    },
  });
  return { routes, acquireGlobalMutation, acquireCwdMutation, closeAllRuntimes, closeRuntimesForCwd, release };
}

function createUsageRoutes(usage: ReturnType<typeof vi.fn>) {
  return createServiceRoutes({
    contextService: {
      async preview() { return { report: "preview" }; },
      async status() { return { report: "status" }; },
      usage,
    },
    control: {
      acquireGlobalMutation: vi.fn(() => ({ release: vi.fn() })),
      acquireCwdMutation: vi.fn(() => ({ release: vi.fn() })),
      closeAllRuntimes: vi.fn(async () => {}),
      closeRuntimesForCwd: vi.fn(async () => {}),
      runtimeInspectionAvailable: false,
      async inspectRuntimeHooks() { return []; },
      sessionExists() { return false; },
    },
  });
}

describe("user-scoped plugin mutation routes", () => {
  it.each([
    ["install", "/plugins/install-local", "POST", {
      cwd: "C:/workspace", sourcePath: "C:/plugin", scope: "user", approvedPermissions: [],
    }],
    ["enable", "/plugins/dev.example.plugin/enable", "POST", { cwd: "C:/workspace" }],
    ["disable", "/plugins/dev.example.plugin/disable", "POST", { cwd: "C:/workspace" }],
    ["uninstall", "/plugins/dev.example.plugin", "DELETE", { cwd: "C:/workspace" }],
  ] as const)("treats %s as a global runtime mutation", async (_operation, path, method, body) => {
    const context = createPluginRoutes();

    const response = await context.routes.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(context.acquireGlobalMutation).toHaveBeenCalledOnce();
    expect(context.acquireCwdMutation).not.toHaveBeenCalled();
    expect(context.closeAllRuntimes).toHaveBeenCalledOnce();
    expect(context.closeRuntimesForCwd).not.toHaveBeenCalled();
    expect(context.release).toHaveBeenCalledOnce();
  });
});

describe("GET /context/usage", () => {
  it("forwards cwd, sessionId, refresh, and previous window to ContextService.usage", async () => {
    const usage = vi.fn(async () => ({
      snapshot: { source: "static_only", tips: [] },
      report: "usage-report",
    }));
    const routes = createUsageRoutes(usage);

    const response = await routes.request(
      "/context/usage?cwd=C%3A%2Fworkspace&sessionId=s1&refresh=true&previousContextWindow=200000",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      snapshot: { source: "static_only", tips: [] },
      report: "usage-report",
    });
    expect(usage).toHaveBeenCalledWith({
      cwd: "C:/workspace",
      sessionId: "s1",
      refresh: true,
      previousContextWindow: 200_000,
    });
  });

  it("returns snapshot and report from ContextService.usage", async () => {
    const usage = vi.fn(async () => ({
      snapshot: {
        model: "m",
        contextWindow: 1000,
        estimatedInputTokens: 10,
        percentFull: 0.01,
        estimator: "heuristic_v1" as const,
        buckets: [],
        tips: [],
        computedAt: "2026-09-05T00:00:00.000Z",
        source: "static_only" as const,
      },
      report: "USAGE REPORT",
    }));
    const routes = createUsageRoutes(usage);

    const response = await routes.request(
      "/context/usage?cwd=/tmp/project&sessionId=s1&refresh=true",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report).toBe("USAGE REPORT");
    expect(body.snapshot.source).toBe("static_only");
    expect(usage).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      sessionId: "s1",
      refresh: true,
    });
  });

  it("requires cwd", async () => {
    const routes = createUsageRoutes(vi.fn(async () => ({ snapshot: {} as never, report: "" })));
    const response = await routes.request("/context/usage");
    expect(response.status).toBe(400);
  });
});
