import type { ToolDefinition } from "@openharness/core";
import { resolveToolPath } from "./path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor } from "./operations.js";

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
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const filePath = resolveToolPath(rawPath, cwd);
    const offset = (input.offset as number) ?? 1;
    const limit = (input.limit as number) ?? 2000;

    try {
      const sandboxError = await sandboxPathError(filePath, cwd, "read", context.settings);
      if (sandboxError) {
        return {
          content: [{ type: "text", text: sandboxError }],
          isError: true,
        };
      }

      const operations = fileOperationsFor(context);
      const fileStat = await operations.stat(filePath);
      if (fileStat.isDirectory) {
        const entries = await operations.listDir(filePath);
        const start = Math.max(0, offset - 1);
        const end = start + limit;
        const listed = entries
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .slice(start, end)
          .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
          .join("\n");
        return {
          content: [{ type: "text", text: listed || "(empty directory)" }],
        };
      }

      const content = await operations.readText(filePath);
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
