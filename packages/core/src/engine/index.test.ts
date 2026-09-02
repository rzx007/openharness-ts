import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";
import { CompactService } from "./compact-service.js";
import { loadSettings, saveProjectSettings, saveSettings } from "../config/settings.js";
import type { StreamEvent, ToolDefinition } from "../index.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function createMockStreamClient(events: StreamEvent[]): any {
  return {
    streamMessage: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createMockPermissionChecker(allow = true): any {
  return {
    checkTool: async () => ({
      action: allow ? "allow" : "deny",
      reason: "mock",
    }),
  };
}

function createMockHookExecutor(): any {
  return {
    execute: async () => ({ blocked: false }),
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: "test",
      description: "test tool",
      inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    registry.register(tool);
    expect(registry.get("test")).toBe(tool);
    expect(registry.has("test")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });

  it("getAll returns all tools", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "", inputSchema: {}, execute: async () => ({ content: [] }) });
    registry.register({ name: "b", description: "", inputSchema: {}, execute: async () => ({ content: [] }) });
    expect(registry.getAll()).toHaveLength(2);
  });

  it("rejects implicit duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(registryTool("Read", "builtin"), { kind: "builtin" });

    expect(() =>
      registry.register(registryTool("Read", "extension"), { kind: "extension" }),
    ).toThrow(expect.objectContaining({ code: "tool_already_registered" }));
    expect(registry.get("Read")?.description).toBe("builtin");
  });

  it("overrides an existing tool and records both sources", () => {
    const registry = new ToolRegistry();
    const replacement = registryTool("Read", "custom");
    registry.register(registryTool("Read", "builtin"), { kind: "builtin" });

    registry.override(replacement, { kind: "agent" });

    expect(registry.get("Read")).toBe(replacement);
    expect(registry.inspect("Read")).toEqual({
      name: "Read",
      source: { kind: "agent" },
      overrides: { kind: "builtin" },
    });
  });

  it("rejects an override whose target does not exist", () => {
    const registry = new ToolRegistry();

    expect(() =>
      registry.override(registryTool("Raed", "custom"), { kind: "agent" }),
    ).toThrow(expect.objectContaining({ code: "tool_override_target_not_found" }));
  });

  it("removes registration metadata when a tool is unregistered", () => {
    const registry = new ToolRegistry();
    registry.register(registryTool("Read", "builtin"), { kind: "builtin" });

    expect(registry.unregister("Read")).toBe(true);
    expect(registry.inspect("Read")).toBeUndefined();
  });
});

function registryTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {},
    execute: async () => ({ content: [] }),
  };
}

describe("QueryEngine", () => {
  it("yields text_delta events for simple response", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "Hello" },
      { type: "complete", stopReason: "end_turn" },
    ];
    const engine = new QueryEngine(
      createMockStreamClient(events),
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor()
    );

    const collected: StreamEvent[] = [];
    for await (const event of engine.submitMessage("hi")) {
      collected.push(event);
    }

    expect(collected.some((e) => e.type === "text_delta")).toBe(true);
    expect(collected.some((e) => e.type === "complete")).toBe(true);
  });

  it("returns history after submit", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "response" },
      { type: "complete", stopReason: "end_turn" },
    ];
    const engine = new QueryEngine(
      createMockStreamClient(events),
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor()
    );

    for await (const _ of engine.submitMessage("hi")) {}
    const history = engine.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.type).toBe("user");
    expect(history[1]!.type).toBe("assistant");
  });

  it("preserves multimodal user content", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "seen" },
      { type: "complete", stopReason: "end_turn" },
    ];
    const engine = new QueryEngine(
      createMockStreamClient(events),
      new ToolRegistry(),
      createMockPermissionChecker(),
      createMockHookExecutor()
    );

    const content = [
      { type: "text" as const, text: "describe this" },
      { type: "image" as const, source: { type: "file" as const, mediaType: "image/png", path: "/tmp/openharness-test.png" } },
    ];
    for await (const _ of engine.submitMessage(content)) {}

    const history = engine.getHistory();
    expect(history[0]).toMatchObject({ type: "user", content });
  });

  it("executes tool calls", async () => {
    const tool: ToolDefinition = {
      name: "Echo",
      description: "echoes input",
      inputSchema: {},
      execute: async (input) => ({
        content: [{ type: "text", text: `echo: ${input.text ?? ""}` }],
      }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const callEvents: StreamEvent[] = [
      { type: "text_delta", delta: "let me check" },
      {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "tu1", name: "Echo", input: { text: "hello" } },
      },
      { type: "complete", stopReason: "tool_use" },
    ];
    const doneEvents: StreamEvent[] = [
      { type: "text_delta", delta: "done" },
      { type: "complete", stopReason: "end_turn" },
    ];

    let callCount = 0;
    const client = {
      streamMessage: async function* () {
        callCount++;
        const evts = callCount === 1 ? callEvents : doneEvents;
        for (const e of evts) yield e;
      },
    };

    const engine = new QueryEngine(
      client,
      registry,
      createMockPermissionChecker(),
      createMockHookExecutor()
    );

    const collected: StreamEvent[] = [];
    for await (const event of engine.submitMessage("use echo")) {
      collected.push(event);
    }

    expect(collected.some((e) => e.type === "tool_use_start")).toBe(true);
    expect(collected.some((e) => e.type === "tool_use_end")).toBe(true);
  });

  it("denies tool when permission denied", async () => {
    const tool: ToolDefinition = {
      name: "Danger",
      description: "dangerous",
      inputSchema: {},
      execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: StreamEvent[] = [
      {
        type: "tool_use_start",
        toolUse: { type: "tool_use", id: "tu1", name: "Danger", input: {} },
      },
      { type: "complete", stopReason: "tool_use" },
    ];
    const doneEvents: StreamEvent[] = [
      { type: "text_delta", delta: "ok" },
      { type: "complete", stopReason: "end_turn" },
    ];

    let callCount = 0;
    const client = {
      streamMessage: async function* () {
        callCount++;
        for (const e of callCount === 1 ? events : doneEvents) yield e;
      },
    };

    const engine = new QueryEngine(
      client,
      registry,
      createMockPermissionChecker(false),
      createMockHookExecutor()
    );

    const collected: StreamEvent[] = [];
    for await (const event of engine.submitMessage("use danger")) {
      collected.push(event);
    }

    const toolEnd = collected.find((e) => e.type === "tool_use_end") as any;
    expect(toolEnd).toBeDefined();
    expect(toolEnd.result.isError).toBe(true);
  });
});

describe("CompactService", () => {
  it("returns messages unchanged when under token limit", async () => {
    const svc = new CompactService(100_000);
    const msgs = [
      { type: "user" as const, content: "short" },
    ];
    expect(await svc.autoCompact(msgs)).toEqual(msgs);
  });

  it("compacts when over limit", async () => {
    const svc = new CompactService(10, 2);
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      type: "user" as const,
      content: `This is message number ${i} with some padding to use tokens`,
    }));
    const result = await svc.autoCompact(msgs);
    expect(result.length).toBeLessThan(msgs.length);
  });

  it("preserves system messages", async () => {
    const svc = new CompactService(10, 2);
    const msgs = [
      { type: "system" as const, content: "system prompt" },
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "user" as const,
        content: `msg ${i} with enough content to fill tokens`,
      })),
    ];
    const result = await svc.autoCompact(msgs);
    expect(result[0]!.type).toBe("system");
  });

  it("microCompact replaces tool results with placeholders", () => {
    const svc = new CompactService();
    const msgs = [
      { type: "user" as const, content: "hi" },
      { type: "tool_result" as const, toolUseId: "tu1", content: [{ type: "text" as const, text: "long output..." }] },
    ];
    const result = svc.microCompact(msgs);
    expect(result[0]!.type).toBe("user");
    expect(result[1]!.type).toBe("tool_result");
  });

  it("estimateTokens returns reasonable estimate", () => {
    const svc = new CompactService();
    const msgs = [
      { type: "user" as const, content: "hello world" },
    ];
    const tokens = svc.estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });
});

describe("loadSettings", () => {
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    savedConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "oh-settings-test-"),
    );
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
    else process.env.OPENHARNESS_CONFIG_DIR = savedConfigDir;
  });

  it("returns default settings with no overrides", async () => {
    const settings = await loadSettings();
    expect(typeof settings.model).toBe("string");
    expect(settings.model.length).toBeGreaterThan(0);
    expect(["anthropic", "openai", "openai_compat"]).toContain(settings.apiFormat);
    expect(settings.permission.mode).toBe("default");
    expect(settings.maxTurns).toBe(50);
    expect(settings.sandbox).toMatchObject({
      enabled: false,
      backend: "srt",
      failIfUnavailable: false,
      filesystem: { allowRead: ["."], allowWrite: ["."] },
      network: { mode: "none" },
      docker: { image: "openharness-sandbox:latest", autoBuildImage: true },
    });
  });

  it("applies cli overrides", async () => {
    const settings = await loadSettings({ model: "gpt-4o", maxTurns: 10 });
    expect(settings.model).toBe("gpt-4o");
    expect(settings.maxTurns).toBe(10);
  });

  it("uses OPENHARNESS_CONFIG_DIR for settings.json", async () => {
    const saved = process.env.OPENHARNESS_CONFIG_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-settings-"));
    const configDir = path.join(tempDir, "config");
    try {
      process.env.OPENHARNESS_CONFIG_DIR = configDir;
      await saveSettings({
        model: "deepseek-chat",
        apiFormat: "openai",
        provider: "deepseek",
        maxTurns: 12,
        permission: { mode: "default" },
      });

      const raw = await fs.readFile(path.join(configDir, "settings.json"), "utf-8");
      expect(JSON.parse(raw).provider).toBe("deepseek");

      const loaded = await loadSettings();
      expect(loaded.provider).toBe("deepseek");
    } finally {
      if (saved === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = saved;
    }
  });

  it("deep merges sandbox file settings with defaults", async () => {
    const configDir = process.env.OPENHARNESS_CONFIG_DIR!;
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        _formatVersion: 1,
        sandbox: {
          enabled: true,
          backend: "docker",
          network: { mode: "bridge" },
          docker: { memoryLimit: "2g" },
        },
      }),
    );

    const settings = await loadSettings();

    expect(settings.sandbox).toMatchObject({
      enabled: true,
      backend: "docker",
      network: {
        mode: "bridge",
        allowedDomains: [],
        deniedDomains: [],
        strictDomainPolicy: false,
      },
      docker: {
        image: "openharness-sandbox:latest",
        memoryLimit: "2g",
        autoBuildImage: true,
      },
    });
  });

  it("merges project settings above global settings when enabled", async () => {
    const configDir = process.env.OPENHARNESS_CONFIG_DIR!;
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oh-project-settings-"));
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        _formatVersion: 1,
        sandbox: {
          enabled: true,
          backend: "docker",
          network: { mode: "none" },
        },
      }),
    );
    await saveProjectSettings({
      sandbox: {
        enabled: true,
        backend: "docker",
        network: { mode: "bridge" },
        docker: { reuseContainer: true },
      },
    }, projectRoot);

    const settings = await loadSettings(undefined, {
      includeProject: true,
      projectRoot,
    });

    expect(settings.sandbox).toMatchObject({
      enabled: true,
      backend: "docker",
      network: { mode: "bridge" },
      docker: {
        image: "openharness-sandbox:latest",
        reuseContainer: true,
      },
    });
  });

  it("applies sandbox environment overrides", async () => {
    const saved = {
      enabled: process.env.OPENHARNESS_SANDBOX_ENABLED,
      backend: process.env.OPENHARNESS_SANDBOX_BACKEND,
      fail: process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE,
      network: process.env.OPENHARNESS_SANDBOX_NETWORK_MODE,
      image: process.env.OPENHARNESS_SANDBOX_DOCKER_IMAGE,
      dns: process.env.OPENHARNESS_SANDBOX_DOCKER_DNS,
      httpProxy: process.env.OPENHARNESS_SANDBOX_HTTP_PROXY,
      httpsProxy: process.env.OPENHARNESS_SANDBOX_HTTPS_PROXY,
      noProxy: process.env.OPENHARNESS_SANDBOX_NO_PROXY,
    };
    try {
      process.env.OPENHARNESS_SANDBOX_ENABLED = "true";
      process.env.OPENHARNESS_SANDBOX_BACKEND = "docker";
      process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE = "1";
      process.env.OPENHARNESS_SANDBOX_NETWORK_MODE = "bridge";
      process.env.OPENHARNESS_SANDBOX_DOCKER_IMAGE = "custom:latest";
      process.env.OPENHARNESS_SANDBOX_DOCKER_DNS = "1.1.1.1, 8.8.8.8";
      process.env.OPENHARNESS_SANDBOX_HTTP_PROXY = "http://host.docker.internal:7890";
      process.env.OPENHARNESS_SANDBOX_HTTPS_PROXY = "http://host.docker.internal:7890";
      process.env.OPENHARNESS_SANDBOX_NO_PROXY = "localhost,127.0.0.1";

      const settings = await loadSettings();

      expect(settings.sandbox).toMatchObject({
        enabled: true,
        backend: "docker",
        failIfUnavailable: true,
        network: { mode: "bridge" },
        docker: {
          image: "custom:latest",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraEnv: {
            HTTP_PROXY: "http://host.docker.internal:7890",
            http_proxy: "http://host.docker.internal:7890",
            HTTPS_PROXY: "http://host.docker.internal:7890",
            https_proxy: "http://host.docker.internal:7890",
            NO_PROXY: "localhost,127.0.0.1",
            no_proxy: "localhost,127.0.0.1",
          },
        },
      });
    } finally {
      if (saved.enabled === undefined) delete process.env.OPENHARNESS_SANDBOX_ENABLED;
      else process.env.OPENHARNESS_SANDBOX_ENABLED = saved.enabled;
      if (saved.backend === undefined) delete process.env.OPENHARNESS_SANDBOX_BACKEND;
      else process.env.OPENHARNESS_SANDBOX_BACKEND = saved.backend;
      if (saved.fail === undefined) delete process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE;
      else process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE = saved.fail;
      if (saved.network === undefined) delete process.env.OPENHARNESS_SANDBOX_NETWORK_MODE;
      else process.env.OPENHARNESS_SANDBOX_NETWORK_MODE = saved.network;
      if (saved.image === undefined) delete process.env.OPENHARNESS_SANDBOX_DOCKER_IMAGE;
      else process.env.OPENHARNESS_SANDBOX_DOCKER_IMAGE = saved.image;
      if (saved.dns === undefined) delete process.env.OPENHARNESS_SANDBOX_DOCKER_DNS;
      else process.env.OPENHARNESS_SANDBOX_DOCKER_DNS = saved.dns;
      if (saved.httpProxy === undefined) delete process.env.OPENHARNESS_SANDBOX_HTTP_PROXY;
      else process.env.OPENHARNESS_SANDBOX_HTTP_PROXY = saved.httpProxy;
      if (saved.httpsProxy === undefined) delete process.env.OPENHARNESS_SANDBOX_HTTPS_PROXY;
      else process.env.OPENHARNESS_SANDBOX_HTTPS_PROXY = saved.httpsProxy;
      if (saved.noProxy === undefined) delete process.env.OPENHARNESS_SANDBOX_NO_PROXY;
      else process.env.OPENHARNESS_SANDBOX_NO_PROXY = saved.noProxy;
    }
  });

  it("ANTHROPIC_BASE_URL does not pollute the generic baseUrl", async () => {
    const savedA = process.env.ANTHROPIC_BASE_URL;
    const savedO = process.env.OPENHARNESS_BASE_URL;
    try {
      // 用户为 Claude Code 设的 ANTHROPIC_BASE_URL 不该灌进通用 baseUrl
      // （否则 deepseek 等非 Anthropic provider 的请求会被发到 anthropic 端点）。
      process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
      delete process.env.OPENHARNESS_BASE_URL;
      const s1 = await loadSettings();
      expect(s1.baseUrl).not.toBe("https://api.anthropic.com");

      // 通用覆盖仍走 OPENHARNESS_BASE_URL。
      process.env.OPENHARNESS_BASE_URL = "https://my.proxy/v1";
      const s2 = await loadSettings();
      expect(s2.baseUrl).toBe("https://my.proxy/v1");
    } finally {
      if (savedA === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = savedA;
      if (savedO === undefined) delete process.env.OPENHARNESS_BASE_URL;
      else process.env.OPENHARNESS_BASE_URL = savedO;
    }
  });
});
