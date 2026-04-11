import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "@openharness/core";

const execAsync = promisify(exec);

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using regular expressions. Returns matching file:line:content entries.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory or file to search in." },
      include: {
        type: "string",
        description: 'File glob pattern to include (e.g. "*.ts").',
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether the search is case-sensitive. Default: true.",
        default: true,
      },
      limit: {
        type: "number",
        description: "Maximum number of matches. Default: 200.",
        default: 200,
      },
    },
    required: ["pattern"],
  },
  async execute(input) {
    const pattern = input.pattern as string;
    const basePath = resolve((input.path as string) ?? process.cwd());
    const include = input.include as string | undefined;
    const caseSensitive = (input.caseSensitive as boolean) ?? true;
    const limit = (input.limit as number) ?? 200;

    try {
      const rgResult = await tryRipgrep(
        basePath,
        pattern,
        include,
        caseSensitive,
        limit
      );
      if (rgResult !== null) {
        return {
          content: [
            {
              type: "text",
              text: rgResult.length > 0 ? rgResult.join("\n") : "(no matches)",
            },
          ],
        };
      }

      const results = await pythonGrep(
        basePath,
        pattern,
        include,
        caseSensitive,
        limit
      );
      return {
        content: [
          {
            type: "text",
            text: results.length > 0 ? results.join("\n") : "(no matches)",
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

async function tryRipgrep(
  basePath: string,
  pattern: string,
  include: string | undefined,
  caseSensitive: boolean,
  limit: number
): Promise<string[] | null> {
  let rgPath: string;
  try {
    const { stdout } = await execAsync("where rg", {
      windowsHide: true,
      timeout: 3000,
    });
    rgPath = stdout.trim().split("\n")[0]!.trim();
  } catch {
    return null;
  }

  const args = ["--no-heading", "--line-number", "--color", "never"];
  if (!caseSensitive) args.push("-i");
  if (include) args.push("--glob", include);
  args.push("--", pattern, ".");

  try {
    const { stdout, stderr } = await execAsync(`"${rgPath}" ${args.map(a => `"${a}"`).join(" ")}`, {
      cwd: basePath,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      timeout: 30_000,
    });
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.slice(0, limit);
  } catch (err: any) {
    if (err.code === 1 && err.stdout) {
      const lines = err.stdout
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean);
      return lines.slice(0, limit);
    }
    if (err.code === 1) return [];
    return null;
  }
}

async function pythonGrep(
  basePath: string,
  pattern: string,
  include: string | undefined,
  caseSensitive: boolean,
  limit: number
): Promise<string[]> {
  const flags = caseSensitive ? "" : "i";
  const regex = new RegExp(pattern, flags);
  const includeRegex = include ? globToRegex(include) : null;
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        try {
          const raw = await readFile(fullPath);
          if (raw.includes(0)) continue; // skip binary files
          const content = raw.toString("utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              const rel = relative(basePath, fullPath);
              results.push(`${rel}:${i + 1}:${lines[i]}`);
              if (results.length >= limit) return;
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  const { stat } = await import("node:fs/promises");
  const st = await stat(basePath);
  if (st.isFile()) {
    const raw = await readFile(basePath);
    const content = raw.toString("utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) {
        results.push(`${basePath}:${i + 1}:${lines[i]}`);
        if (results.length >= limit) break;
      }
    }
  } else {
    await walk(basePath);
  }

  return results;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
