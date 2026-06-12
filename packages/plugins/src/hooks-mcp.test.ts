import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginManifestSchema } from "./discovery.js";
import { loadPluginHooks, loadPluginMcp } from "./hooks-mcp.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ohs-hm-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function manifest(extra: Record<string, unknown> = {}) {
  return PluginManifestSchema.parse({ name: "hp", ...extra });
}

describe("loadPluginHooks (flat hooks.json)", () => {
  it("loads command hooks per event with generated ids and enabled=true", async () => {
    writeFileSync(
      join(tmp, "hooks.json"),
      JSON.stringify({
        pre_tool_use: [{ type: "command", command: "echo pre", timeout: 5 }],
        stop: [{ type: "command", command: "echo done" }],
      }),
    );
    const hooks = await loadPluginHooks(tmp, manifest());
    expect(hooks).toHaveLength(2);
    const pre = hooks.find((h) => h.event === "pre_tool_use")!;
    expect(pre.type).toBe("command");
    expect((pre as { command: string }).command).toBe("echo pre");
    expect(pre.enabled).toBe(true);
    expect(pre.id).toContain("hp");
    expect(pre.timeout).toBe(5);
  });

  it("skips unknown events and malformed entries instead of crashing", async () => {
    writeFileSync(
      join(tmp, "hooks.json"),
      JSON.stringify({
        not_an_event: [{ type: "command", command: "x" }],
        pre_tool_use: ["not an object", { type: "command", command: "ok" }],
      }),
    );
    const hooks = await loadPluginHooks(tmp, manifest());
    expect(hooks).toHaveLength(1);
    expect((hooks[0] as { command: string }).command).toBe("ok");
  });

  it("returns [] when the hooks file is missing or corrupt", async () => {
    expect(await loadPluginHooks(tmp, manifest())).toEqual([]);
    writeFileSync(join(tmp, "hooks.json"), "not json");
    expect(await loadPluginHooks(tmp, manifest())).toEqual([]);
  });
});

describe("loadPluginHooks (structured hooks/hooks.json, Claude Code style)", () => {
  it("falls back to the structured format and substitutes ${CLAUDE_PLUGIN_ROOT}", async () => {
    mkdirSync(join(tmp, "hooks"), { recursive: true });
    writeFileSync(
      join(tmp, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          pre_tool_use: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh", timeout: 10 }],
            },
          ],
        },
      }),
    );
    const hooks = await loadPluginHooks(tmp, manifest());
    expect(hooks).toHaveLength(1);
    const hook = hooks[0]!;
    expect(hook.event).toBe("pre_tool_use");
    expect(hook.matcher).toBe("Bash");
    expect((hook as { command: string }).command).toBe(`${tmp}/scripts/check.sh`);
    expect(hook.timeout).toBe(10);
  });

  it("flat file wins over structured when both exist", async () => {
    writeFileSync(join(tmp, "hooks.json"), JSON.stringify({ stop: [{ type: "command", command: "flat" }] }));
    mkdirSync(join(tmp, "hooks"), { recursive: true });
    writeFileSync(
      join(tmp, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { stop: [{ matcher: "", hooks: [{ type: "command", command: "structured" }] }] } }),
    );
    const hooks = await loadPluginHooks(tmp, manifest());
    expect(hooks).toHaveLength(1);
    expect((hooks[0] as { command: string }).command).toBe("flat");
  });
});

describe("loadPluginMcp", () => {
  it("loads mcpServers from the manifest mcp_file", async () => {
    writeFileSync(
      join(tmp, "mcp.json"),
      JSON.stringify({ mcpServers: { db: { command: "db-server", args: [] } } }),
    );
    const servers = await loadPluginMcp(tmp, manifest());
    expect(Object.keys(servers)).toEqual(["db"]);
  });

  it("falls back to .mcp.json (Claude Code layout)", async () => {
    writeFileSync(join(tmp, ".mcp.json"), JSON.stringify({ mcpServers: { web: { url: "http://x" } } }));
    const servers = await loadPluginMcp(tmp, manifest());
    expect(Object.keys(servers)).toEqual(["web"]);
  });

  it("returns {} for missing, corrupt, or mcpServers-less files", async () => {
    expect(await loadPluginMcp(tmp, manifest())).toEqual({});
    writeFileSync(join(tmp, "mcp.json"), "boom");
    expect(await loadPluginMcp(tmp, manifest())).toEqual({});
    writeFileSync(join(tmp, "mcp.json"), JSON.stringify({ other: 1 }));
    expect(await loadPluginMcp(tmp, manifest())).toEqual({});
  });
});
