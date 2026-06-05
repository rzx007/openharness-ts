import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import type { ToolDefinition } from "@openharness/core";

// Lines longer than this are skipped rather than processed, mirroring the
// Python implementation's 64 KB guard. This prevents pathological minified
// files / binary-ish content from blowing up memory or output size.
const MAX_LINE_BYTES = 64 * 1024;

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

function findRipgrep(): string | null {
  // `where` (Windows) / `which` (POSIX) both print candidate paths on stdout.
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(finder, ["rg"], {
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

async function tryRipgrep(
  basePath: string,
  pattern: string,
  include: string | undefined,
  caseSensitive: boolean,
  limit: number
): Promise<string[] | null> {
  const rgPath = findRipgrep();
  if (!rgPath) return null;

  const args = ["--no-heading", "--line-number", "--color", "never"];
  // Include hidden files when searching inside what looks like a repo. ripgrep
  // still honours .gitignore, so this only surfaces tracked/un-ignored dotfiles
  // (e.g. .github/) rather than .venv or node_modules.
  if (existsSync(join(basePath, ".git")) || existsSync(join(basePath, ".gitignore"))) {
    args.push("--hidden");
  }
  if (!caseSensitive) args.push("-i");
  if (include) args.push("--glob", include);
  // `--` ensures patterns like `-foo` are treated as the search pattern.
  args.push("--", pattern, ".");

  return new Promise<string[] | null>((resolvePromise) => {
    // stderr is routed to "ignore" (not a pipe): an unread stderr pipe can fill
    // the OS buffer and deadlock ripgrep on noisy errors. We don't need it.
    const child = spawn(rgPath, args, {
      cwd: basePath,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const matches: string[] = [];
    let buffer = "";
    let settled = false;
    let killedForLimit = false;

    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      killedForLimit = true;
      child.kill("SIGKILL");
      finish(matches.slice(0, limit));
    }, 30_000);

    const pushLine = (line: string) => {
      // Skip overlong lines instead of choking on them.
      if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) return;
      const trimmed = line.trim();
      if (trimmed) matches.push(trimmed);
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        pushLine(line);
        if (matches.length >= limit) {
          killedForLimit = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          finish(matches.slice(0, limit));
          return;
        }
      }
    });

    child.on("error", () => {
      clearTimeout(timer);
      // ripgrep failed to spawn — fall back to the Python implementation.
      finish(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (buffer) pushLine(buffer);
      // rg: 0 = matches found, 1 = no matches. Either way the results are valid.
      // SIGKILL (null code) from our own limit/timeout handling is also fine.
      if (killedForLimit || code === 0 || code === 1 || code === null) {
        finish(matches.slice(0, limit));
      } else {
        // Unexpected error code — fall back to Python.
        finish(null);
      }
    });
  });
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

  const matchLines = (content: string, displayPath: string): boolean => {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip overlong lines instead of running the regex over them.
      if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) continue;
      if (regex.test(line)) {
        results.push(`${displayPath}:${i + 1}:${line}`);
        if (results.length >= limit) return true;
      }
    }
    return false;
  };

  async function walk(dir: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        if (results.length >= limit) return;
      } else if (entry.isFile()) {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        try {
          const raw = await readFile(fullPath);
          if (raw.includes(0)) continue; // skip binary files
          const content = raw.toString("utf-8");
          const rel = relative(basePath, fullPath);
          if (matchLines(content, rel)) return;
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
    matchLines(content, basePath);
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
