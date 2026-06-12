import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandRegistry } from "@openharness/commands";
import { registerBuiltinCommandsOnRegistry, type SlashCommandContext } from "./slash-commands.js";

// E.2 批次命令的最小 ctx 冒烟：handler 是已测功能的薄组合，这里只断输出形状。
let tmp: string;
let savedSettings: Record<string, unknown> | null = null;

function makeCtx(): SlashCommandContext {
  const settings = {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 50,
    permission: { mode: "default" },
    outputStyle: "minimal",
    allowProjectPlugins: true,
  } as never;
  return {
    getEngine: () =>
      ({
        getHistory: () => [{ type: "user", content: "hello world" }],
        getTotalUsage: () => ({ inputTokens: 1, outputTokens: 2 }),
      }) as never,
    getModel: () => "m",
    setModel: () => {},
    getSettings: () => settings,
    updateSettings: async (patch: Record<string, unknown>) => {
      savedSettings = patch;
    },
    hookExecutor: { register: () => {} } as never,
    taskManager: { listTasks: () => [] } as never,
    skillRegistry: { register: () => {}, registerBundled: () => {}, getAll: () => [] } as never,
    exitRepl: () => {},
    refreshSystemPrompt: async () => {},
    getBundle: () =>
      ({
        toolRegistry: { getAll: () => [{ name: "Bash" }] },
        hookExecutor: { register: () => {} },
      }) as never,
    credentialStorage: {} as never,
  } as SlashCommandContext;
}

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerBuiltinCommandsOnRegistry(registry, makeCtx());
  return registry;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohs-slash-"));
  savedSettings = null;
  process.env.OPENHARNESS_CONFIG_DIR = join(tmp, "cfg");
});

afterEach(() => {
  delete process.env.OPENHARNESS_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("E.2 批次命令", () => {
  it("/stats 输出会话统计各字段", async () => {
    const result = await makeRegistry().execute("/stats", { args: {}, raw: "/stats" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("- messages: 1");
    expect(result.output).toContain("estimated_tokens:");
    expect(result.output).toContain("- tools: 1");
    expect(result.output).toContain("- output_style: minimal");
  });

  it("/subagents 列出三源人格并标注来源", async () => {
    const result = await makeRegistry().execute("/subagents", { args: {}, raw: "/subagents" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Explore [builtin]");
    expect(result.output).toContain("worker [builtin]");
  });

  it("/plugin enable 持久化到 settings.plugins;非法用法给提示", async () => {
    const registry = makeRegistry();
    const enable = await registry.execute("/plugin", { args: {}, raw: "/plugin enable demo" });
    expect(enable.output).toContain("Enabled plugin 'demo'");
    expect(savedSettings).toEqual({ plugins: { demo: true } });

    const usage = await registry.execute("/plugin", { args: {}, raw: "/plugin frobnicate" });
    expect(usage.output).toContain("Usage:");
  });

  it("/reload-plugins 重新发现插件(空目录提示无插件)", async () => {
    // 项目目录无插件、用户目录指向空临时 cfg → 视环境可能有真实用户插件,
    // 只断不抛错且输出非空。
    const result = await makeRegistry().execute("/reload-plugins", { args: {}, raw: "/reload-plugins" });
    expect(result.success).toBe(true);
    expect((result.output ?? "").length).toBeGreaterThan(0);
  });
});
