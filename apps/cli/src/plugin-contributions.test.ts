import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry } from "@openharness/skills";
import {
  pluginCommandToSkill,
  loadPluginContributions,
  registerPluginHooks,
  mergePluginMcpServers,
  getLoadedPlugins,
} from "./plugin-contributions.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohs-pc-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeProjectPlugin(name: string, files: Record<string, string>): void {
  const dir = join(tmp, ".openharness", "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name }));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

describe("pluginCommandToSkill", () => {
  it("maps a plugin command onto the SkillDefinition shape", () => {
    const skill = pluginCommandToSkill({
      name: "p:lint",
      description: "Lint",
      content: "Run lint.",
      source: "plugin",
      path: "/x/lint.md",
      argumentHint: "[path]",
      model: "m",
      userInvocable: true,
      disableModelInvocation: false,
      isSkill: false,
    });
    expect(skill.name).toBe("p:lint");
    expect(skill.commandName).toBe("p:lint");
    expect(skill.source).toBe("plugin");
    expect(skill.content).toBe("Run lint.");
    expect(skill.argumentHint).toBe("[path]");
  });
});

describe("loadPluginContributions", () => {
  it("registers enabled plugin skills and commands into the SkillRegistry", async () => {
    makeProjectPlugin("dev", {
      "skills/deploy/SKILL.md": "Deploy skill.",
      "commands/lint.md": "Lint command.",
    });
    const registry = new SkillRegistry();
    const { warnings } = await loadPluginContributions(registry, { allowProjectPlugins: true }, tmp);

    expect(registry.get("deploy")).toBeDefined();
    expect(registry.get("dev:lint")).toBeDefined();
    expect(registry.get("deploy")!.source).toBe("plugin");
    expect(warnings).toEqual([]);
  });

  it("caches loaded plugins, registers hooks, and merges MCP with user priority", async () => {
    makeProjectPlugin("full", {
      "hooks.json": JSON.stringify({ stop: [{ type: "command", command: "echo bye" }] }),
      "mcp.json": JSON.stringify({ mcpServers: { db: { command: "plugin-db" }, web: { url: "http://p" } } }),
    });
    const registry = new SkillRegistry();
    await loadPluginContributions(registry, { allowProjectPlugins: true }, tmp);
    expect(getLoadedPlugins().map((p) => p.manifest.name)).toContain("full");

    const registered: unknown[] = [];
    const count = registerPluginHooks({ register: (h) => registered.push(h) });
    expect(count).toBe(1);
    expect((registered[0] as { event: string }).event).toBe("stop");

    // 用户 settings 同名 server 优先，插件不覆盖。
    const merged = mergePluginMcpServers({ db: { command: "user-db" } } as never);
    expect((merged.db as { command: string }).command).toBe("user-db");
    expect(merged.web).toBeDefined();
  });

  it("skips disabled plugins and surfaces trust warnings", async () => {
    makeProjectPlugin("blocked", { "commands/x.md": "X." });
    const registry = new SkillRegistry();

    // 未开门控：不注册 + 告警。
    const gated = await loadPluginContributions(registry, {}, tmp);
    expect(registry.get("blocked:x")).toBeUndefined();
    expect(gated.warnings.length).toBeGreaterThan(0);

    // 开门控但 settings.plugins 显式禁用：仍不注册。
    const disabled = await loadPluginContributions(
      registry,
      { allowProjectPlugins: true, plugins: { blocked: false } },
      tmp,
    );
    expect(registry.get("blocked:x")).toBeUndefined();
    expect(disabled.warnings).toEqual([]);
  });
});
