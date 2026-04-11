import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "@openharness/core";

export const fileWriteTool: ToolDefinition = {
  name: "Write",
  description:
    "Write a file to the local filesystem. Will overwrite existing files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to write to." },
      content: { type: "string", description: "Content to write." },
    },
    required: ["file_path", "content"],
  },
  async execute(input) {
    const filePath = input.file_path as string;
    const content = input.content as string;

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");
      return {
        content: [{ type: "text", text: `Successfully wrote to ${filePath}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error writing file: ${error}` }],
        isError: true,
      };
    }
  },
};
