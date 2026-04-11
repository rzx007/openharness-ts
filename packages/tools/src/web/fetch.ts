import type { ToolDefinition } from "@openharness/core";

export const webFetchTool: ToolDefinition = {
  name: "WebFetch",
  description: "Fetch content from a URL.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch." },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Response format.",
      },
    },
    required: ["url"],
  },
  async execute(input) {
    const url = input.url as string;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return {
          content: [
            { type: "text", text: `HTTP ${response.status}: ${response.statusText}` },
          ],
          isError: true,
        };
      }

      const text = await response.text();
      return { content: [{ type: "text", text: text.slice(0, 50_000) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error fetching URL: ${error}` }],
        isError: true,
      };
    }
  },
};
