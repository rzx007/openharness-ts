import { join } from "node:path";
import type { ToolDefinition } from "@openharness/core";

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
    const { SkillRegistry, SkillLoader } = await import("@openharness/skills");
    const { getSkillsDir } = await import("@openharness/core");
    const name = input.name as string;

    let registry = context.skillRegistry as InstanceType<typeof SkillRegistry> | undefined;

    // Load skills if not already loaded
    if (!registry) {
      registry = new SkillRegistry();
      const loader = new SkillLoader(registry);
      await loader.loadFromDirectory(getSkillsDir(), { source: "user" });
      await loader.loadFromDirectory(join(context.cwd, ".openharness", "skills"), { source: "project" });
    }

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
