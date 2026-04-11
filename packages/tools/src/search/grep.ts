import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@openharness/core";

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using regular expressions. Returns matching file paths and line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory to search in." },
      include: {
        type: "string",
        description: 'File pattern to include (e.g. "*.ts").',
      },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const pattern = input.pattern as string;
    const basePath = (input.path as string) ?? process.cwd();
    const include = input.include as string | undefined;

    try {
      const regex = new RegExp(pattern, "i");
      const results: string[] = [];

      const { readdir } = await import("node:fs/promises");
      const includeRegex = include ? globToRegex(include) : null;

      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            if (includeRegex && !includeRegex.test(entry.name)) continue;
            try {
              const content = await readFile(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i]!)) {
                  results.push(fullPath);
                  break;
                }
              }
            } catch {
              // skip unreadable files
            }
          }
        }
      }

      await walk(basePath);

      return {
        content: [
          {
            type: "text",
            text: results.length > 0 ? results.join("\n") : "No matches found.",
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  },
};

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
