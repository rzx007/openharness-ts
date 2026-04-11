import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "@openharness/core";

export const fileReadTool: ToolDefinition = {
  name: "Read",
  description:
    "Read a file or directory from the local filesystem.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file or directory." },
      offset: { type: "number", description: "Start line (1-indexed)." },
      limit: { type: "number", description: "Max lines to read." },
    },
    required: ["file_path"],
  },
  async execute(input) {
    const filePath = input.file_path as string;
    const offset = (input.offset as number) ?? 1;
    const limit = (input.limit as number) ?? 2000;

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, offset - 1);
      const end = start + limit;
      const slice = lines.slice(start, end);
      const numbered = slice
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
      return { content: [{ type: "text", text: numbered }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading file: ${error}` }],
        isError: true,
      };
    }
  },
};
