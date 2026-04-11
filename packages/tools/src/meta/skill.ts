import type { ToolDefinition } from "@openharness/core";

export const skillTool: ToolDefinition = {
  name: "Skill",
  description: "Read a bundled, user, or plugin skill by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name" },
    },
    required: ["name"],
  },
  async execute(input, context) {
    const { SkillRegistry } = await import("@openharness/skills");
    const name = input.name as string;
    const registry = new SkillRegistry();
    await registry.discover(context.cwd);
    const skill =
      registry.get(name) ??
      registry.get(name.toLowerCase()) ??
      registry.get(name.charAt(0).toUpperCase() + name.slice(1));
    if (!skill) {
      return { content: [{ type: "text", text: `Skill not found: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: skill.content }] };
  },
};
