import type { Settings } from "@openharness/core";
import type {
  CommandCatalogEntry,
  CommandCatalogProvider,
  ExpandCommandInput,
  ExpandCommandResult,
  ListCommandsInput,
} from "@openharness/server";
import { normalizeCommandName } from "@openharness/server";
import { SkillRegistry, type SkillDefinition } from "@openharness/skills";

import { buildSkillPrompt, loadSkillsThreeSources, matchUserInvocableSkill } from "./commands/main.js";

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

async function loadSkillRegistry(cwd: string, settings: Settings): Promise<SkillRegistry> {
  const skillRegistry = new SkillRegistry();
  await loadSkillsThreeSources(skillRegistry, cwd, settings);
  return skillRegistry;
}

/**
 * cwd-scoped command catalog for the daemon.
 * Exposes user-invocable skills as template commands; does not host the old REPL registry.
 */
export function createCliCommandCatalog(
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
      const match = matchUserInvocableSkill(line, skillRegistry, () => false);
      if (!match) return null;
      return {
        prompt: buildSkillPrompt(match.skill, match.args),
        command: skillToCatalogEntry(match.skill),
      };
    },
  };
}
