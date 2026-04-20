import type { ToolDefinition } from "@openharness/core";

export const toolSearchTool: ToolDefinition = {
  name: "ToolSearch",
  description: "Search the available tool list by name or description.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Substring to search in tool names and descriptions" },
    },
    required: ["query"],
  },
  async execute(input) {
    const { createDefaultToolRegistry } = await import("../registry");
    const query = (input.query as string).toLowerCase();
    const registry = createDefaultToolRegistry();
    const allTools = registry.getAll();
    const matches = allTools.filter(
      (t) => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query)
    );
    if (matches.length === 0) {
      return { content: [{ type: "text", text: "(no matches)" }] };
    }
    const text = matches.map((t) => `${t.name}: ${t.description}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
};
