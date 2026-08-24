import { join } from "node:path";
import type { ToolDefinition } from "@openharness/core";
import type { SkillDefinition, SkillRegistry } from "@openharness/skills";

type SkillRegistryInstance = InstanceType<typeof SkillRegistry>;
type SkillVisibility = "model" | "user" | "all";

export const skillTool: ToolDefinition = {
  name: "Skill",
  description:
    "Read a bundled, user, or plugin skill by name. Returns the skill's full Markdown content.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name" },
    },
    required: ["name"],
  },
  async execute(input, context) {
    const name = input.name as string;

    const registry = await resolveSkillRegistry(context);

    const skill = registry.resolve(name);
    if (!skill) {
      return {
        content: [{ type: "text", text: `Skill not found: ${name}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: skill.content }] };
  },
};

export const listSkillsTool: ToolDefinition = {
  name: "ListSkills",
  description:
    "List bundled, user, project, or plugin skills available in this runtime. Returns names, descriptions, sources, and slash command names, not full skill contents.",
  inputSchema: {
    type: "object",
    properties: {
      visibility: {
        type: "string",
        enum: ["model", "user", "all"],
        description:
          "Which skills to list. 'model' lists skills visible to the model, 'user' lists slash-command skills, and 'all' lists every loaded skill.",
      },
    },
  },
  async execute(input, context) {
    const visibility = parseVisibility(input.visibility);
    const registry = await resolveSkillRegistry(context);
    const skills = filterSkills(registry.getAll(), visibility);

    if (skills.length === 0) {
      return {
        content: [{ type: "text", text: `No ${visibility} skills available.` }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: formatSkillList(skills, visibility),
        },
      ],
    };
  },
};

async function resolveSkillRegistry(context: { cwd: string; skillRegistry?: unknown }) {
  const sharedRegistry = context.skillRegistry as SkillRegistryInstance | undefined;
  if (sharedRegistry) return sharedRegistry;

  const { SkillRegistry, SkillLoader } = await import("@openharness/skills");
  const { getSkillsDir } = await import("@openharness/core");
  const registry = new SkillRegistry();
  registry.registerBundled();
  const loader = new SkillLoader(registry);
  await loader.loadFromDirectory(getSkillsDir(), { source: "user", recursive: true });
  await loader.loadFromDirectory(join(context.cwd, ".openharness", "skills"), {
    source: "project",
    recursive: true,
  });
  await loader.loadFromDirectory(join(context.cwd, ".claude", "skills"), {
    source: "project",
    recursive: true,
  });
  return registry;
}

function parseVisibility(value: unknown): SkillVisibility {
  return value === "user" || value === "all" ? value : "model";
}

function filterSkills(
  skills: readonly SkillDefinition[],
  visibility: SkillVisibility,
): readonly SkillDefinition[] {
  if (visibility === "all") return skills;
  if (visibility === "user") return skills.filter((skill) => skill.userInvocable);
  return skills.filter((skill) => skill.disableModelInvocation !== true);
}

function formatSkillList(skills: readonly SkillDefinition[], visibility: SkillVisibility): string {
  const title =
    visibility === "model"
      ? "Model-visible skills"
      : visibility === "user"
        ? "User-invocable skills"
        : "All loaded skills";
  return [
    `${title}:`,
    ...skills.map((skill) => {
      const command = skill.commandName ?? skill.name;
      const metadata = [
        skill.source ? `source=${skill.source}` : null,
        skill.userInvocable ? `command=/${command}` : null,
        skill.disableModelInvocation ? "model=hidden" : null,
      ].filter(Boolean);
      return `- ${skill.name}${skill.description ? ` — ${skill.description}` : ""}${
        metadata.length ? ` (${metadata.join(", ")})` : ""
      }`;
    }),
  ].join("\n");
}
