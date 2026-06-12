import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  PluginManifestSchema,
  findManifest,
  getUserPluginsDir,
  getProjectPluginsDir,
  discoverPluginPaths,
  loadPlugin,
  loadPlugins,
} from "./discovery.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohs-plugins-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** 在 root 下建一个带 plugin.json 的插件目录。 */
function makePlugin(root: string, name: string, manifest: Record<string, unknown> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  return dir;
}

describe("PluginManifestSchema", () => {
  it("applies Python-aligned defaults", () => {
    const m = PluginManifestSchema.parse({ name: "p" });
    expect(m.version).toBe("0.0.0");
    expect(m.description).toBe("");
    expect(m.enabled_by_default).toBe(true);
    expect(m.skills_dir).toBe("skills");
    expect(m.tools_dir).toBe("tools");
    expect(m.hooks_file).toBe("hooks.json");
    expect(m.mcp_file).toBe("mcp.json");
  });

  it("rejects a missing or empty name", () => {
    expect(PluginManifestSchema.safeParse({}).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts commands in string / array / record forms", () => {
    expect(PluginManifestSchema.safeParse({ name: "p", commands: "cmds" }).success).toBe(true);
    expect(PluginManifestSchema.safeParse({ name: "p", commands: ["a.md", "b"] }).success).toBe(true);
    expect(
      PluginManifestSchema.safeParse({
        name: "p",
        commands: { lint: { source: "lint.md" }, fix: { content: "do fix" } },
      }).success,
    ).toBe(true);
  });
});

describe("findManifest", () => {
  it("finds root plugin.json, preferring it over .claude-plugin/", () => {
    const dir = makePlugin(tmp, "p1");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
    expect(findManifest(dir)).toBe(join(dir, "plugin.json"));
  });

  it("falls back to .claude-plugin/plugin.json (Claude Code layout)", () => {
    const dir = join(tmp, "cc-style");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cc-style" }));
    expect(findManifest(dir)).toBe(join(dir, ".claude-plugin", "plugin.json"));
  });

  it("returns null when neither exists", () => {
    const dir = join(tmp, "not-a-plugin");
    mkdirSync(dir);
    expect(findManifest(dir)).toBeNull();
  });
});

describe("plugins dir helpers", () => {
  it("getUserPluginsDir points at ~/.openharness/plugins without creating it", () => {
    expect(getUserPluginsDir()).toBe(join(homedir(), ".openharness", "plugins"));
  });

  it("getProjectPluginsDir is <cwd>/.openharness/plugins and does not mkdir", () => {
    const dir = getProjectPluginsDir(tmp);
    expect(dir).toBe(join(tmp, ".openharness", "plugins"));
    expect(existsSync(dir)).toBe(false);
  });
});

describe("discoverPluginPaths", () => {
  it("skips project plugins by default and emits a trust warning", () => {
    const projectRoot = getProjectPluginsDir(tmp);
    makePlugin(projectRoot, "sneaky");

    const { paths, warnings } = discoverPluginPaths({}, tmp);
    expect(paths.find((p) => p.includes("sneaky"))).toBeUndefined();
    expect(warnings.some((w) => w.includes("allowProjectPlugins"))).toBe(true);
  });

  it("includes project plugins when allowProjectPlugins=true, no warning", () => {
    const projectRoot = getProjectPluginsDir(tmp);
    const dir = makePlugin(projectRoot, "trusted");

    const { paths, warnings } = discoverPluginPaths({ allowProjectPlugins: true }, tmp);
    expect(paths).toContain(dir);
    expect(warnings).toEqual([]);
  });

  it("includes extraRoots, sorted per root, deduped, non-plugins ignored", () => {
    const rootA = join(tmp, "rootA");
    const b = makePlugin(rootA, "bbb");
    const a = makePlugin(rootA, "aaa");
    mkdirSync(join(rootA, "not-plugin")); // 无 manifest，应被忽略
    writeFileSync(join(rootA, "file.txt"), ""); // 非目录

    const { paths } = discoverPluginPaths({}, tmp, [rootA, rootA]);
    const inRootA = paths.filter((p) => p.startsWith(rootA));
    expect(inRootA).toEqual([a, b]); // 排序 + 去重(rootA 传两次)
  });
});

describe("loadPlugin", () => {
  it("loads manifest with enabled from enabled_by_default", async () => {
    const dir = makePlugin(tmp, "p1", { description: "hello" });
    const plugin = (await loadPlugin(dir, {}))!;
    expect(plugin.manifest.name).toBe("p1");
    expect(plugin.manifest.description).toBe("hello");
    expect(plugin.enabled).toBe(true);
    expect(plugin.path).toBe(dir);
  });

  it("settings.plugins map overrides enabled_by_default", async () => {
    const dir = makePlugin(tmp, "p2", { enabled_by_default: true });
    expect((await loadPlugin(dir, { p2: false }))!.enabled).toBe(false);

    const dir3 = makePlugin(tmp, "p3", { enabled_by_default: false });
    expect((await loadPlugin(dir3, { p3: true }))!.enabled).toBe(true);
  });

  it("returns null for corrupt or missing manifests", async () => {
    const bad = join(tmp, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "plugin.json"), "not json");
    expect(await loadPlugin(bad, {})).toBeNull();

    const empty = join(tmp, "empty");
    mkdirSync(empty);
    expect(await loadPlugin(empty, {})).toBeNull();
  });
});

describe("loadPlugin fills contributions", () => {
  it("loads skills and commands from the plugin layout", async () => {
    const dir = makePlugin(tmp, "rich");
    mkdirSync(join(dir, "skills", "deploy"), { recursive: true });
    writeFileSync(join(dir, "skills", "deploy", "SKILL.md"), "Deploy skill.");
    mkdirSync(join(dir, "commands"), { recursive: true });
    writeFileSync(join(dir, "commands", "lint.md"), "Lint command.");

    const plugin = (await loadPlugin(dir, {}))!;
    expect(plugin.skills.map((s) => s.commandName)).toEqual(["deploy"]);
    expect(plugin.commands.map((c) => c.name)).toEqual(["rich:lint"]);
  });
});

describe("loadPlugins (end to end over extraRoots)", () => {
  it("loads all discovered plugins with enabled flags and surfaces warnings", async () => {
    const root = join(tmp, "root");
    makePlugin(root, "on");
    makePlugin(root, "off", { enabled_by_default: false });
    const projectRoot = getProjectPluginsDir(tmp);
    makePlugin(projectRoot, "gated");

    const { plugins, warnings } = await loadPlugins({ plugins: {} }, tmp, [root]);
    const names = plugins.map((p) => p.manifest.name);
    expect(names).toContain("on");
    expect(names).toContain("off");
    expect(names).not.toContain("gated");
    expect(plugins.find((p) => p.manifest.name === "off")!.enabled).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
