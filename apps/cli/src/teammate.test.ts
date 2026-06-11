import { describe, it, expect } from "vitest";
import { buildTeammateCommand } from "./teammate.js";
import type { Settings } from "@openharness/core";
import type { TeammateSpawnConfig } from "@openharness/swarm";

const BASE_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  maxTurns: 50,
  permission: { mode: "default" },
};

function makeConfig(overrides: Partial<TeammateSpawnConfig> = {}): TeammateSpawnConfig {
  return {
    name: "Explore",
    team: "default",
    prompt: "investigate the bug",
    cwd: "/work",
    parentSessionId: "main",
    ...overrides,
  };
}

describe("buildTeammateCommand", () => {
  it("produces --print one-shot argv with prompt and model", () => {
    const { argv } = buildTeammateCommand(makeConfig(), BASE_SETTINGS);
    expect(argv).toContain("--print");
    expect(argv).toContain("investigate the bug");
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe("claude-sonnet-4-20250514");
    // --print immediately precedes the prompt positional
    const printIdx = argv.indexOf("--print");
    expect(argv[printIdx + 1]).toBe("investigate the bug");
  });

  it("config.model takes priority over settings.model", () => {
    const { argv } = buildTeammateCommand(
      makeConfig({ model: "gpt-4o" }),
      BASE_SETTINGS,
    );
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("gpt-4o");
  });

  it("falls back to settings.model when config.model is undefined", () => {
    const { argv } = buildTeammateCommand(
      makeConfig({ model: undefined }),
      { ...BASE_SETTINGS, model: "minimax-parent" },
    );
    const modelIdx = argv.indexOf("--model");
    expect(argv[modelIdx + 1]).toBe("minimax-parent");
  });

  it("includes -s when systemPrompt present", () => {
    const { argv } = buildTeammateCommand(
      makeConfig({ systemPrompt: "You are Explore." }),
      BASE_SETTINGS,
    );
    const sIdx = argv.indexOf("-s");
    expect(sIdx).toBeGreaterThan(-1);
    expect(argv[sIdx + 1]).toBe("You are Explore.");
  });

  it("omits -s when no systemPrompt", () => {
    const { argv } = buildTeammateCommand(makeConfig(), BASE_SETTINGS);
    expect(argv).not.toContain("-s");
  });

  it("passes through provider, base-url, api-format", () => {
    const { argv } = buildTeammateCommand(makeConfig(), {
      ...BASE_SETTINGS,
      provider: "openrouter",
      baseUrl: "https://example.test/v1",
      apiFormat: "openai",
    });
    expect(argv[argv.indexOf("--provider") + 1]).toBe("openrouter");
    expect(argv[argv.indexOf("--base-url") + 1]).toBe("https://example.test/v1");
    expect(argv[argv.indexOf("--api-format") + 1]).toBe("openai");
  });

  it("defaults --permission-mode to default even when leader runs full_auto", () => {
    // worker 不继承 leader 的宽模式：写操作必须走文件流由 leader 集中裁决，
    // 否则 worker 自己放行，permission-sync 的批准路径成为死代码。
    const { argv } = buildTeammateCommand(makeConfig(), {
      ...BASE_SETTINGS,
      permission: { mode: "full_auto" },
    });
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
  });

  it("config.permissionMode overrides the default permission mode", () => {
    const { argv } = buildTeammateCommand(
      makeConfig({ permissionMode: "full_auto" }),
      BASE_SETTINGS,
    );
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("full_auto");
  });

  it("omits provider/base-url when not set", () => {
    const { argv } = buildTeammateCommand(makeConfig(), BASE_SETTINGS);
    expect(argv).not.toContain("--provider");
    expect(argv).not.toContain("--base-url");
  });

  it("includes --swarm-worker for all teammates (read-only auto-approval)", () => {
    const { argv } = buildTeammateCommand(makeConfig(), BASE_SETTINGS);
    expect(argv).toContain("--swarm-worker");
  });

  it("injects swarm identity env vars (team / agent id / agent name)", () => {
    const { env } = buildTeammateCommand(makeConfig({ name: "Explore", team: "alpha" }), BASE_SETTINGS);
    expect(env).toEqual({
      CLAUDE_CODE_TEAM_NAME: "alpha",
      CLAUDE_CODE_AGENT_ID: "Explore@alpha",
      CLAUDE_CODE_AGENT_NAME: "Explore",
    });
  });

  it("never includes the api-key", () => {
    const { argv } = buildTeammateCommand(makeConfig(), {
      ...BASE_SETTINGS,
      apiKey: "sk-secret-123",
    });
    expect(argv).not.toContain("--api-key");
    expect(argv.join(" ")).not.toContain("sk-secret-123");
  });
});
