import { describe, it, expect } from "vitest";
import {
  createOpenHarnessRuntime,
  resolveAutoApproveTools,
  resolveRuntimeModel,
} from "./default-runtime.js";
import { LOCAL_READ_ONLY_TOOLS, READ_ONLY_TOOLS } from "@openharness/permissions";
import type { Settings } from "@openharness/core";

const BASE_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  maxTurns: 50,
  permission: { mode: "default" },
};

describe("resolveAutoApproveTools", () => {
  const base = { permission: { mode: "default" } } as Settings;
  const withSettings = {
    permission: { mode: "default", autoApproveTools: ["TodoWrite"] },
  } as Settings;

  it("无任何来源 → undefined(checker 默认行为)", () => {
    expect(resolveAutoApproveTools(base, {})).toBeUndefined();
  });

  it("settings.permission.autoApproveTools 接线(此前被忽略)", () => {
    expect(resolveAutoApproveTools(withSettings, {})).toEqual(["TodoWrite"]);
  });

  it("autoApproveReadOnly 只注入非本地只读工具(channels serve 无头模式)", () => {
    const tools = new Set(resolveAutoApproveTools(base, { autoApproveReadOnly: true }));
    expect(tools.has("Read")).toBe(false);
    expect(tools.has("Glob")).toBe(false);
    expect(tools.has("Grep")).toBe(false);
    expect(tools.has("Lsp")).toBe(false);
    expect(tools.has("TaskList")).toBe(true);
    expect(tools.has("WebFetch")).toBe(true);
    expect(tools.has("Write")).toBe(false);
    expect(tools.has("Bash")).toBe(false);
    expect(tools.size).toBe(READ_ONLY_TOOLS.size - LOCAL_READ_ONLY_TOOLS.size);
  });

  it("overrides.autoApproveTools 显式列表合并(channels serve 收窄集)", () => {
    const tools = new Set(resolveAutoApproveTools(base, { autoApproveTools: ["Read", "Glob"] }));
    expect(tools).toEqual(new Set(["Read", "Glob"]));
  });

  it("settings 显式本地只读授权与 readOnly 合并", () => {
    const tools = new Set(
      resolveAutoApproveTools(
        { permission: { mode: "default", autoApproveTools: ["TodoWrite", "Read"] } } as Settings,
        { autoApproveReadOnly: true },
      ),
    );
    expect(tools.has("TodoWrite")).toBe(true);
    expect(tools.has("Read")).toBe(true);
    expect(tools.size).toBe(READ_ONLY_TOOLS.size - LOCAL_READ_ONLY_TOOLS.size + 2);
  });
});

describe("resolveRuntimeModel", () => {
  it("prefers CLI override model over settings model", () => {
    expect(resolveRuntimeModel(BASE_SETTINGS, { model: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  });

  it("falls back to settings model when no override is provided", () => {
    expect(resolveRuntimeModel(BASE_SETTINGS, {})).toBe(BASE_SETTINGS.model);
  });
});

describe("createOpenHarnessRuntime tool visibility", () => {
  it("applies allowedTools and deniedTools to tools registered after runtime creation", async () => {
    const runtime = await createOpenHarnessRuntime({
      settings: {
        ...BASE_SETTINGS,
        permission: { mode: "default", allowedTools: ["Bash"] },
      },
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        allowedTools: ["ToolSearch", "DynamicAllowed"],
        disallowedTools: ["DynamicDenied"],
      },
    });

    runtime.toolRegistry.register({
      name: "DynamicAllowed",
      description: "Allowed dynamic tool",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });
    runtime.toolRegistry.register({
      name: "DynamicDenied",
      description: "Denied dynamic tool",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toEqual(["ToolSearch", "DynamicAllowed"]);
      expect(runtime.toolRegistry.get("DynamicAllowed")).toBeDefined();
      expect(runtime.toolRegistry.get("DynamicDenied")).toBeUndefined();
      expect(runtime.toolRegistry.get("ToolSearch")).toBeDefined();
      expect(runtime.toolRegistry.get("Bash")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("treats '*' as all tools while deniedTools still wins", async () => {
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        allowedTools: ["*"],
        disallowedTools: ["file_write"],
      },
    });

    runtime.toolRegistry.register({
      name: "DynamicMcpTool",
      description: "Dynamic MCP tool",
      inputSchema: {},
      async execute() {
        return { content: [] };
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toContain("Bash");
      expect(names).toContain("Read");
      expect(names).toContain("DynamicMcpTool");
      expect(names).not.toContain("Write");
      expect(runtime.toolRegistry.get("Write")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("normalizes common old-world tool names before filtering", async () => {
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        allowedTools: ["bash", "file_edit", "tool_search"],
        disallowedTools: ["TOOL_SEARCH"],
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toEqual(["Bash", "Edit"]);
      expect(runtime.toolRegistry.get("Bash")).toBeDefined();
      expect(runtime.toolRegistry.get("Edit")).toBeDefined();
      expect(runtime.toolRegistry.get("ToolSearch")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
