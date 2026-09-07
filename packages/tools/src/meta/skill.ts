import type { ToolDefinition } from "@openharness/core";
import type { SkillDefinition, SkillRegistry } from "@openharness/skills";
import { dirname } from "node:path";

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

    const registry = await resolveSkillRegistry(context, { refreshFilesystem: true });

    const skill = registry.resolve(name);
    if (!skill) {
      return {
        content: [{ type: "text", text: `Skill not found: ${name}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: formatLoadedSkill(skill, context) }],
    };
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
    const registry = await resolveSkillRegistry(context, { refreshFilesystem: true });
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

async function resolveSkillRegistry(
  context: {
    cwd: string;
    skillRegistry?: unknown;
    environment?: { workspace: { hostRoot: string } };
  },
  options: { refreshFilesystem?: boolean } = {},
) {
  const sharedRegistry = context.skillRegistry as SkillRegistryInstance | undefined;
  if (sharedRegistry && !options.refreshFilesystem) return sharedRegistry;

  const { createSkillRegistrySnapshot, findProjectSkillDirs } = await import("@openharness/skills");
  const { getSkillsDir } = await import("@openharness/core");
  const baseline = sharedRegistry?.getAll().filter((skill) =>
    skill.source === "plugin" || !skill.path
  ) ?? [];
  return createSkillRegistrySnapshot({
    baseline,
    userDir: getSkillsDir(),
    projectDirs: await findProjectSkillDirs(
      context.environment?.workspace?.hostRoot ?? context.cwd,
    ),
  });
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

function formatLoadedSkill(
  skill: SkillDefinition,
  context: Parameters<ToolDefinition["execute"]>[1],
): string {
  const embedded = !skill.path;
  const skillFile = embedded
    ? "(embedded)"
    : context.environment?.paths.presentHostPath(skill.path) ??
      (context.environment ? "(unavailable in this environment)" : skill.path);
  const skillRoot = embedded
    ? "(embedded)"
    : context.environment?.paths.presentHostPath(dirname(skill.path)) ??
      (context.environment ? "(unavailable in this environment)" : dirname(skill.path));
  const unavailable = !embedded && context.environment &&
    (skillFile.startsWith("(unavailable") || skillRoot.startsWith("(unavailable"));
  return [
    `Skill: ${skill.name}`,
    `Skill file: ${skillFile}`,
    `Skill root: ${skillRoot}`,
    "",
    "Resolve relative paths mentioned by this skill against Skill root.",
    ...(unavailable
      ? ["This Skill's supporting files are not mounted in the execution environment."]
      : []),
    "",
    "<skill-content>",
    skill.content,
    "</skill-content>",
  ].join("\n");
}
