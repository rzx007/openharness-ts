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
