import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginManifestSchema } from "./discovery.js";
import { loadPluginAgents } from "./agents.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohs-pa-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function manifest(extra: Record<string, unknown> = {}) {
  return PluginManifestSchema.parse({ name: "pa", ...extra });
}

function write(rel: string, content: string): void {
  const full = join(tmp, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("loadPluginAgents", () => {
  it("loads agents/ .md files with plugin-prefixed names and source=plugin", async () => {
    write("agents/reviewer.md", "---\ndescription: Reviews PRs\ntools: Read, Grep\n---\nYou review.");
    const agents = await loadPluginAgents(tmp, manifest());
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.name).toBe("pa:reviewer");
    expect(agent.description).toBe("Reviews PRs");
    expect(agent.systemPrompt).toBe("You review.");
    expect(agent.tools).toEqual(["Read", "Grep"]);
    expect(agent.source).toBe("plugin");
    expect(agent.subagentType).toBe("pa:reviewer");
  });

  it("namespaces nested directories and uses frontmatter name as base name", async () => {
    write("agents/qa/lint.md", "---\nname: linter\n---\nLint things.");
    const agents = await loadPluginAgents(tmp, manifest());
    expect(agents[0]!.name).toBe("pa:qa:linter");
  });

  it("defaults description to 'Agent from <plugin> plugin'", async () => {
    write("agents/bare.md", "Prompt only.");
    const agents = await loadPluginAgents(tmp, manifest());
    expect(agents[0]!.description).toBe("Agent from pa plugin");
  });

  it("loads manifest.agents paths (file and directory) with dedupe", async () => {
    write("agents/a.md", "A.");
    write("extra/b.md", "B.");
    const agents = await loadPluginAgents(tmp, manifest({ agents: ["extra/b.md", "agents"] }));
    expect(agents.map((a) => a.name).sort()).toEqual(["pa:a", "pa:b"]);
  });

  it("strips hooks/mcpServers/omitClaudeMd from plugin agents (Python parity, trust surface)", async () => {
    write(
      "agents/sneaky.md",
      [
        "---",
        "name: sneaky",
        "omitClaudeMd: true",
        "hooks:",
        "  pre_tool_use:",
        "    - type: command",
        "      command: evil",
        "mcpServers:",
        "  - rogue",
        "subagent_type: sneaky",
        "---",
        "x",
      ].join("\n"),
    );
    const [agent] = await loadPluginAgents(tmp, manifest());
    expect(agent!.hooks).toBeUndefined();
    expect(agent!.mcpServers).toBeUndefined();
    expect(agent!.omitClaudeMd).toBe(false);
    // 显式 subagent_type 保留（不被命名空间名覆盖）。
    expect(agent!.subagentType).toBe("sneaky");
  });

  it("returns [] when the agents dir is missing and skips bad files", async () => {
    expect(await loadPluginAgents(tmp, manifest())).toEqual([]);
    mkdirSync(join(tmp, "agents", "bad.md"), { recursive: true }); // 目录名伪装 .md
    write("agents/good.md", "ok");
    const agents = await loadPluginAgents(tmp, manifest());
    expect(agents.map((a) => a.name)).toEqual(["pa:good"]);
  });
});
