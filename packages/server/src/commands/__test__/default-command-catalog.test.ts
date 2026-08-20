import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Settings } from "@openharness/core";
import {
  getAgentDefinition,
  registerPluginAgents,
} from "@openharness/coordinator";
import { discoverOpenHarnessExtensions } from "@openharness/agent-runtime";

import { createDefaultCommandCatalog } from "../default-command-catalog.js";

function minimalSettings(): Settings {
  return {
    model: "m",
    apiFormat: "anthropic",
    maxTurns: 32,
    permission: { mode: "default" },
  };
}

describe("createDefaultCommandCatalog", () => {
  it("lists bundled user-invocable skills as template commands and expands them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-catalog-"));
    try {
      const catalog = createDefaultCommandCatalog(minimalSettings());
      const commands = await catalog.list({ cwd: dir });
      expect(commands.map((command) => command.name)).toEqual(
        expect.arrayContaining(["/commit", "/review", "/plan"]),
      );
      expect(commands.every((command) => command.kind === "template")).toBe(true);

      const expanded = await catalog.expand!({ cwd: dir, name: "/commit", args: "fix auth" });
      expect(expanded?.command.name).toBe("/commit");
      expect(expanded?.prompt).toContain("## Arguments");
      expect(expanded?.prompt).toContain("fix auth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes project skills from cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohs-catalog-project-"));
    try {
      const skillDir = join(dir, ".openharness", "skills");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "ship.md"),
        "---\nname: ship\ndescription: Ship it\nuser-invocable: true\n---\nShip the change.\n",
      );
      const catalog = createDefaultCommandCatalog(minimalSettings());
      const commands = await catalog.list({ cwd: dir });
      expect(commands.find((command) => command.name === "/ship")).toMatchObject({
        kind: "template",
        source: "project",
        description: "Ship it",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads commands for cwd B without replacing the agent definitions already active for cwd A", async () => {
    const root = mkdtempSync(join(tmpdir(), "ohs-catalog-scoped-agents-"));
    const cwdA = join(root, "workspace-a");
    const cwdB = join(root, "workspace-b");
    const previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = join(root, "config");

    function writePlugin(cwd: string, model: string, command: string): void {
      const pluginDir = join(cwd, ".openharness", "plugins", "scoped");
      mkdirSync(join(pluginDir, "agents"), { recursive: true });
      mkdirSync(join(pluginDir, "commands"), { recursive: true });
      writeFileSync(
        join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "scoped", version: "1.0.0" }),
      );
      writeFileSync(
        join(pluginDir, "agents", "reviewer.md"),
        `---\nmodel: ${model}\n---\nReview this workspace.\n`,
      );
      writeFileSync(
        join(pluginDir, "commands", `${command}.md`),
        `---\ndescription: ${command} command\n---\nRun ${command}.\n`,
      );
    }

    const settings: Settings = {
      ...minimalSettings(),
      allowProjectPlugins: true,
    };

    try {
      writePlugin(cwdA, "model-a", "command-a");
      writePlugin(cwdB, "model-b", "command-b");
      const discoveryA = await discoverOpenHarnessExtensions(cwdA, settings);
      registerPluginAgents(discoveryA.agentDefinitions);

      const commands = await createDefaultCommandCatalog(settings).list({
        cwd: cwdB,
      });

      expect(commands.map((command) => command.name)).toContain(
        "/scoped:command-b",
      );
      expect(getAgentDefinition("scoped:reviewer")?.model).toBe("model-a");
    } finally {
      registerPluginAgents([]);
      if (previousConfigDir === undefined) {
        delete process.env.OPENHARNESS_CONFIG_DIR;
      } else {
        process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
