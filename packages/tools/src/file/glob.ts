import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition } from "@openharness/core";

export const globTool: ToolDefinition = {
  name: "Glob",
  description:
    "Fast file pattern matching tool. Supports glob patterns like **/*.ts.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern (e.g. "**/*.ts").' },
      path: { type: "string", description: "Directory to search in." },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const pattern = input.pattern as string;
    const basePath = (input.path as string) ?? process.cwd();

    try {
      const files = await walkGlob(basePath, pattern);
      const sorted = files.sort();

      return {
        content: [
          {
            type: "text" as const,
            text: sorted.length > 0 ? sorted.join("\n") : "No files matched.",
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  },
};

async function walkGlob(dir: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  const regex = globToRegex(pattern);

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(dir, fullPath);
        if (regex.test(rel)) {
          results.push(rel);
        }
      }
    }
  }

  await walk(dir);
  return results;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`);
}
