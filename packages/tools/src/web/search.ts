import type { ToolDefinition } from "@openharness/core";

export const webSearchTool: ToolDefinition = {
  name: "WebSearch",
  description: "Search the web using a query.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
    },
    required: ["query"],
  },
  async execute(input) {
    return {
      content: [
        { type: "text", text: "WebSearch tool not yet implemented." },
      ],
    };
  },
};
