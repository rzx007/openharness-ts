import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type Settings } from "@openharness/core";
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
    const config = applyMcpAuthConfig("remote", { type: "http", url: "https://mcp.example" }, {
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
    const config = applyMcpAuthConfig("local-db", { type: "stdio", command: "node", args: ["server.js"] }, {
      serverName: "local-db",
      mode: "env",
      value: "secret",
    });

    expect(config.env).toEqual({ LOCAL_DB_API_KEY: "secret" });
  });

  it("rejects auth modes that cannot affect the server transport", () => {
    expect(() => applyMcpAuthConfig("local", { type: "stdio", command: "node" }, {
      serverName: "local",
      mode: "bearer",
      value: "tok",
    })).toThrow("bearer only works for HTTP/SSE");

    expect(() => applyMcpAuthConfig("remote", { type: "http", url: "https://mcp.example" }, {
      serverName: "remote",
      mode: "env",
      value: "tok",
    })).toThrow("env only works for stdio");

    expect(() => applyMcpAuthConfig("remote", { type: "http", url: "https://mcp.example" }, {
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
  it("persists config, reconnects with the new config, and registers live MCP tools", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { type: "http", url: "https://mcp.example" } },
    };
    let persisted: Settings | undefined;
    const connection: Partial<McpConnection> = { status: "connected" };
    const manager = {
      getConnection: vi.fn(),
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
    registry.register({
      name: "mcp__remote__old",
      description: "old",
      inputSchema: {},
      execute: vi.fn(),
    });
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: registry,
      persistSettings: async (next) => { persisted = next; },
    });

    const result = await host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    });

    expect(result.message).toContain("Saved MCP auth for remote");
    expect(persisted?.mcpServers?.remote?.headers).toEqual({ Authorization: "Bearer tok" });
    expect(settings.mcpServers?.remote?.headers).toEqual({ Authorization: "Bearer tok" });
    expect(manager.reconnect).toHaveBeenCalledWith("remote", {
      type: "http",
      url: "https://mcp.example",
      headers: { Authorization: "Bearer tok" },
    });
    expect(registry.has("mcp__remote__query")).toBe(true);
    expect(registry.has("mcp__remote__old")).toBe(false);
    expect(registry.has("mcp__other__query")).toBe(false);
  });

  it("reports reconnect failure instead of claiming success", async () => {
    const settings: Settings = {
      ...baseSettings,
      mcpServers: { remote: { type: "http", url: "https://mcp.example" } },
    };
    const manager = {
      getConnection: vi.fn(),
      reconnect: vi.fn(async () => ({
        status: "error",
        error: new Error("401 Unauthorized"),
      })),
      getAsToolDefinitions: vi.fn(() => []),
    } as unknown as McpClientManager;
    const registry = new ToolRegistry();
    registry.register({
      name: "mcp__remote__old",
      description: "old",
      inputSchema: {},
      execute: vi.fn(),
    });
    const host = createMcpAuthHost({
      settings,
      mcpManager: manager,
      toolRegistry: registry,
      persistSettings: async () => {},
    });

    await expect(host.configure({
      serverName: "remote",
      mode: "bearer",
      value: "tok",
    })).rejects.toThrow("reconnect failed: 401 Unauthorized");
    expect(registry.has("mcp__remote__old")).toBe(false);
  });
});
