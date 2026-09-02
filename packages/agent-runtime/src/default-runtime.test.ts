import { describe, it, expect, vi } from "vitest";

const startSandboxRuntime = vi.hoisted(() => vi.fn(async () => ({
  status: {
    state: "off" as const,
    enabled: false,
    active: false,
    backend: "docker" as const,
  },
  stop: vi.fn(async () => {}),
  stopSync: vi.fn(),
})));

vi.mock("@openharness/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openharness/sandbox")>()),
  startSandboxRuntime,
}));
import {
  createOpenHarnessRuntime,
  resolveAutoApproveTools,
  resolveCustomProviderRuntime,
  resolveEffectiveAllowedTools,
  resolveRuntimeModel,
} from "./default-runtime.js";
import { LOCAL_READ_ONLY_TOOLS, READ_ONLY_TOOLS } from "@openharness/permissions";
import type { Settings, ToolDefinition } from "@openharness/core";

function testTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: {},
    async execute() {
      return { content: [] };
    },
  };
}

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
    expect(tools.has("JobList")).toBe(true);
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

  it("does not implicitly auto-approve an overridden read-only tool", () => {
    expect(
      resolveAutoApproveTools(
        base,
        { autoApproveReadOnly: true },
        new Set(["WebFetch"]),
      ),
    ).not.toContain("WebFetch");
    expect(
      resolveAutoApproveTools(
        base,
        { autoApproveReadOnly: true, autoApproveTools: ["WebFetch"] },
        new Set(["WebFetch"]),
      ),
    ).toContain("WebFetch");
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

describe("resolveCustomProviderRuntime", () => {
  it("resolves a selected custom provider as an OpenAI-compatible endpoint", () => {
    const settings: Settings = {
      ...BASE_SETTINGS,
      provider: "office-gateway",
      customProviders: [
        {
          id: "office-gateway",
          displayName: "Office Gateway",
          baseUrl: "https://gateway.example/v1",
          apiFormat: "openai",
          models: [{ id: "team-model", displayName: "Team Model" }],
          headers: { "X-Tenant": "desktop" },
        },
      ],
    };

    expect(resolveCustomProviderRuntime(settings, "office-gateway")).toEqual({
      backendType: "openai_compat",
      baseURL: "https://gateway.example/v1",
      headers: { "X-Tenant": "desktop" },
    });
  });

  it("does not resolve a provider that is not custom", () => {
    expect(resolveCustomProviderRuntime(BASE_SETTINGS, "anthropic")).toBeUndefined();
  });
});

describe("resolveEffectiveAllowedTools", () => {
  it("intersects host ceiling with role tools", () => {
    expect(resolveEffectiveAllowedTools({
      hostToolCeiling: ["Read", "Agent"],
      roleAllowedTools: ["*", "Bash", "Edit"],
      knownToolNames: ["Read", "Agent", "Bash", "Edit"],
    })).toEqual({ kind: "only", names: new Set(["Read", "Agent"]) });

    expect(resolveEffectiveAllowedTools({
      hostToolCeiling: ["Read", "Agent", "Workflow"],
      roleAllowedTools: ["Agent", "Workflow"],
      knownToolNames: ["Read", "Agent", "Workflow"],
    })).toEqual({ kind: "only", names: new Set(["Agent", "Workflow"]) });

    expect(resolveEffectiveAllowedTools({
      hostToolCeiling: ["Read"],
      roleAllowedTools: ["Bash"],
      knownToolNames: ["Read", "Bash"],
    })).toEqual({ kind: "only", names: new Set() });
  });

  it("represents an unrestricted limit explicitly", () => {
    expect(resolveEffectiveAllowedTools({
      knownToolNames: ["Read", "Bash"],
    })).toEqual({ kind: "all" });
  });
});

describe("createOpenHarnessRuntime tool visibility", () => {
  it("registers agent tools before applying visibility filters", async () => {
    const custom = testTool("BusinessSearch");
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        tools: [custom],
        hostToolCeiling: ["BusinessSearch"],
      },
    });

    try {
      expect(runtime.toolRegistry.get("BusinessSearch")).toBe(custom);
      expect(runtime.toolRegistry.inspect("BusinessSearch")).toEqual({
        name: "BusinessSearch",
        source: { kind: "agent" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("replaces a built-in only through toolOverrides and records provenance", async () => {
    const replacement = testTool("Read");
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        toolOverrides: [replacement],
      },
    });

    try {
      expect(runtime.toolRegistry.get("Read")).toBe(replacement);
      expect(runtime.toolRegistry.inspect("Read")).toEqual({
        name: "Read",
        source: { kind: "agent" },
        overrides: { kind: "builtin" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects ambiguous additions and invalid overrides before startup", async () => {
    const client = {
      async *streamMessage() {
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      },
    };

    await expect(createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: { client, tools: [testTool("Read")] },
    })).rejects.toThrow(/already registered/i);
    await expect(createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: { client, toolOverrides: [testTool("Raed")] },
    })).rejects.toThrow(/override target.*not registered/i);
    await expect(createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client,
        tools: [testTool("BusinessSearch")],
        toolOverrides: [testTool("BusinessSearch")],
      },
    })).rejects.toThrow(/both tools and toolOverrides/i);
  });

  it("mounts attachmentResourceRoot read-only without treating it as an attachment API", async () => {
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
      },
      attachmentResourceRoot: "D:/session-attachments",
    });

    try {
      expect(startSandboxRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
        managedReadOnlyMounts: [{
          source: "D:/session-attachments",
          target: "/mnt/openharness-attachments",
        }],
      }));
      expect(runtime.toolRegistry.get("ReadAttachment")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("rejects removed lifecycle names with the Jobs replacement", async () => {
    await expect(createOpenHarnessRuntime({
      settings: {
        ...BASE_SETTINGS,
        permission: { mode: "default", deniedTools: ["task_wait"] },
      },
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
      },
    })).rejects.toThrow(
      'settings.permission.deniedTools contains removed lifecycle tool names: "task_wait" -> "JobWait"',
    );
  });

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
        hostToolCeiling: ["ToolSearch", "DynamicAllowed"],
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

  it("keeps roleAllowedTools under the host tool ceiling", async () => {
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["Read", "Agent"],
        roleAllowedTools: ["*"],
      },
    });

    try {
      const names = runtime.toolRegistry.getAll().map((tool) => tool.name);
      expect(names).toEqual(["Read", "Agent"]);
      expect(runtime.toolRegistry.get("Bash")).toBeUndefined();
      expect(runtime.toolRegistry.get("Edit")).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it("exposes zero tools when the host ceiling and role tools do not overlap", async () => {
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["Read"],
        roleAllowedTools: ["Bash"],
      },
    });

    try {
      expect(runtime.toolRegistry.getAll()).toEqual([]);
      expect(runtime.toolRegistry.get("Read")).toBeUndefined();
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
        hostToolCeiling: ["*"],
        disallowedTools: ["Write"],
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

  it("uses the current exact tool names when filtering", async () => {
    const runtime = await createOpenHarnessRuntime({
      settings: BASE_SETTINGS,
      configuration: {
        client: {
          async *streamMessage() {
            yield { type: "complete" as const, stopReason: "end_turn" as const };
          },
        },
        hostToolCeiling: ["Bash", "Edit", "ToolSearch"],
        disallowedTools: ["ToolSearch"],
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
