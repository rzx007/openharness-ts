import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { ToolDefinition } from "@openharness/core";

// System directories that must never be edited, regardless of permission mode.
const SYSTEM_DIR_PREFIXES = [
  "/etc/", "/sys/", "/proc/", "/dev/", "/boot/",
  "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/",
  "c:\\windows\\", "c:\\program files\\", "c:\\program files (x86)\\",
];

function isSystemPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").toLowerCase();
  return SYSTEM_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, "/")));
}

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
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();

    if (!oldString) {
      return {
        content: [{ type: "text", text: "old_string must not be empty." }],
        isError: true,
      };
    }

    const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

    if (isSystemPath(filePath)) {
      return {
        content: [{ type: "text", text: `Error: editing system directory files is not allowed: ${filePath}` }],
        isError: true,
      };
    }

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
