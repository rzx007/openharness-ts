import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import type { ToolDefinition } from "@openharness/core";

// System directories that must never be written to, regardless of permission mode.
const SYSTEM_DIR_PREFIXES = [
  "/etc/", "/sys/", "/proc/", "/dev/", "/boot/",
  "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/",
  "c:\\windows\\", "c:\\program files\\", "c:\\program files (x86)\\",
];

function isSystemPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").toLowerCase();
  return SYSTEM_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, "/")));
}

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
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const content = input.content as string;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();

    // Resolve to absolute path, then guard against system directories.
    const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

    if (isSystemPath(filePath)) {
      return {
        content: [{ type: "text", text: `Error: writing to system directory is not allowed: ${filePath}` }],
        isError: true,
      };
    }

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
