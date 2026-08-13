import type { Settings } from "@openharness/core";
import type {
  CommandCatalogEntry,
  CommandCatalogProvider,
  ExpandCommandInput,
  ExpandCommandResult,
  ListCommandsInput,
} from "./commands.js";
import { normalizeCommandName } from "./commands.js";
import { discoverOpenHarnessExtensions } from "@openharness/agent-runtime";
import type { SkillDefinition } from "@openharness/skills";

function skillToCatalogEntry(skill: SkillDefinition): CommandCatalogEntry {
  const name = normalizeCommandName(skill.commandName ?? skill.name);
  return {
    name,
    description: skill.description,
    kind: "template",
    source: skill.source === "plugin" ? "plugin" : skill.source === "project" ? "project" : "skill",
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
  };
}

async function loadSkillRegistry(cwd: string, settings: Settings) {
  return (await discoverOpenHarnessExtensions(cwd, settings)).skillRegistry;
}

/**
 * cwd-scoped command catalog for the daemon.
 * Exposes user-invocable skills as template commands; does not host the old REPL registry.
 */
export function createDefaultCommandCatalog(
  settings: Settings | (() => Settings),
): CommandCatalogProvider {
  const getSettings = typeof settings === "function" ? settings : () => settings;
  return {
    async list(input: ListCommandsInput): Promise<CommandCatalogEntry[]> {
      const skillRegistry = await loadSkillRegistry(input.cwd, getSettings());
      return skillRegistry
        .getAll()
        .filter((skill) => skill.userInvocable)
        .map(skillToCatalogEntry);
    },

    async expand(input: ExpandCommandInput): Promise<ExpandCommandResult | null> {
      const skillRegistry = await loadSkillRegistry(input.cwd, getSettings());
      const line = `${normalizeCommandName(input.name)}${input.args ? ` ${input.args}` : ""}`;
      const trimmed = line.trim();
      const separator = trimmed.indexOf(" ");
      const name = (separator < 0 ? trimmed : trimmed.slice(0, separator)).replace(/^\//, "");
      const args = separator < 0 ? "" : trimmed.slice(separator + 1).trim();
      const skill = skillRegistry.resolve(name);
      if (!skill?.userInvocable) return null;
      return {
        prompt: args ? `${skill.content.trimEnd()}\n\n## Arguments\n${args}\n` : skill.content,
        command: skillToCatalogEntry(skill),
      };
    },
  };
}
