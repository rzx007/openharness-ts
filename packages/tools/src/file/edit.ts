import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "@openharness/core";

export const fileEditTool: ToolDefinition = {
  name: "Edit",
  description:
    "Perform exact string replacements in files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file." },
      old_string: { type: "string", description: "Text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace all occurrences." },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async execute(input) {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    try {
      const content = await readFile(filePath, "utf-8");

      if (!content.includes(oldString)) {
        return {
          content: [{ type: "text", text: "old_string not found in file." }],
          isError: true,
        };
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences > 1 && !replaceAll) {
        return {
          content: [
            {
              type: "text",
              text: `Found ${occurrences} matches. Use replace_all to replace all.`,
            },
          ],
          isError: true,
        };
      }

      const updated = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);

      const { writeFile } = await import("node:fs/promises");
      await writeFile(filePath, updated, "utf-8");

      return {
        content: [{ type: "text", text: `Successfully edited ${filePath}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error editing file: ${error}` }],
        isError: true,
      };
    }
  },
};
