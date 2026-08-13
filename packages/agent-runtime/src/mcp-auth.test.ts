import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type McpServerConfig, type Settings } from "@openharness/core";
import type { McpClientManager, McpConnection } from "@openharness/mcp";

import { applyMcpAuthConfig, createMcpAuthHost, defaultMcpEnvKey } from "./mcp-auth.js";

const baseSettings: Settings = {
  model: "test-model",
  apiFormat: "anthropic",
  maxTurns: 10,
  permission: { mode: "default" },
};

describe("applyMcpAuthConfig", () => {
  it("writes bearer auth as an Authorization header for HTTP MCP servers", () => {
    const config = applyMcpAuthConfig("remote", { url: "https://mcp.example" }, {
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    });

    expect(config.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("writes custom header auth for HTTP MCP servers", () => {
    const config = applyMcpAuthConfig("remote", { type: "sse", url: "https://mcp.example/sse" }, {
      serverName: "remote",
      mode: "header",
      key: "X-API-Key",
      value: "secret",
    });

    expect(config.headers).toEqual({ "X-API-Key": "secret" });
  });

  it("writes env auth for stdio MCP servers", () => {
    const config = applyMcpAuthConfig("local-db", { command: "node", args: ["server.js"] }, {
      serverName: "local-db",
      mode: "env",
      value: "secret",
    });

    expect(config.env).toEqual({ LOCAL_DB_API_KEY: "secret" });
  });

  it("rejects auth modes that cannot affect the server transport", () => {
    expect(() => applyMcpAuthConfig("local", { command: "node" }, {
      serverName: "local",
      mode: "bearer",
      value: "tok",
    })).toThrow("bearer only works for HTTP/SSE");

    expect(() => applyMcpAuthConfig("remote", { url: "https://mcp.example" }, {
      serverName: "remote",
      mode: "env",
      value: "tok",
    })).toThrow("env only works for stdio");

    expect(() => applyMcpAuthConfig("remote", { url: "https://mcp.example" }, {
      serverName: "remote",
      mode: "header",
      value: "tok",
    })).toThrow("header requires a header key");
  });

  it("uses a stable default env key", () => {
    expect(defaultMcpEnvKey("local-db")).toBe("LOCAL_DB_API_KEY");
  });
});

describe("createMcpAuthHost", () => {
  it("reconnects first, persists only after success, and registers live MCP tools", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { url: "https://mcp.example" } },
    };
    const persisted: Array<{ serverName: string; config: McpServerConfig }> = [];
    const connection: Partial<McpConnection> = { status: "connected" };
    const manager = {
      getConnection: vi.fn(() => ({ status: "connected", config: settings.mcpServers!.remote })),
      reconnect: vi.fn(async () => connection),
      getAsToolDefinitions: vi.fn(() => [
        {
          name: "mcp__remote__query",
          description: "query",
          inputSchema: { type: "object", properties: {} },
          execute: vi.fn(),
        },
        {
          name: "mcp__other__query",
          description: "other",
          inputSchema: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ]),
    } as unknown as McpClientManager;
    const registry = new ToolRegistry();
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: registry,
      persistMcpServer: async (serverName, config) => {
        persisted.push({ serverName, config });
      },
    });

    const result = await host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    });

    expect(result.message).toContain("Saved MCP auth for remote");
    expect(persisted).toEqual([{
      serverName: "remote",
      config: {
        url: "https://mcp.example",
        headers: { Authorization: "Bearer tok" },
      },
    }]);
    expect(settings.mcpServers?.remote?.headers).toEqual({ Authorization: "Bearer tok" });
    expect(manager.reconnect).toHaveBeenCalledWith("remote", {
      url: "https://mcp.example",
      headers: { Authorization: "Bearer tok" },
    });
    expect(registry.has("mcp__remote__query")).toBe(true);
    expect(registry.has("mcp__other__query")).toBe(false);
  });

  it("does not persist auth and restores the previous connection after reconnect failure", async () => {
    const previous = {
      url: "https://mcp.example",
      headers: { Authorization: "Bearer good" },
    };
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: previous },
    };
    const persistMcpServer = vi.fn(async () => "global" as const);
    const manager = {
      getConnection: vi.fn(() => ({ status: "connected", config: previous })),
      reconnect: vi.fn(async (_name: string, config: McpServerConfig) => {
        if (config.headers?.Authorization === "Bearer bad") {
          return {
            status: "error",
            error: new Error("401 Unauthorized"),
          };
        }
        return { status: "connected", config };
      }),
      getAsToolDefinitions: vi.fn(() => []),
    } as unknown as McpClientManager;
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: new ToolRegistry(),
      persistMcpServer,
    });

    await expect(host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "bad",
    })).rejects.toThrow("Auth was not saved");

    expect(persistMcpServer).not.toHaveBeenCalled();
    expect(settings.mcpServers?.remote).toEqual(previous);
    expect(manager.reconnect).toHaveBeenNthCalledWith(1, "remote", {
      url: "https://mcp.example",
      headers: { Authorization: "Bearer bad" },
    });
    expect(manager.reconnect).toHaveBeenNthCalledWith(2, "remote", previous);
  });
});
