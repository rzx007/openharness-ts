import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, relative } from "node:path";
import type { ToolDefinition } from "@openharness/core";
import { resolveToolPath } from "./path.js";
import { sandboxPathError } from "./sandbox-guard.js";

const DEFAULT_LIMIT = 200;
const RG_TIMEOUT_MS = 30_000;

// Directories that are almost always noise and very expensive to traverse.
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
]);

export const globTool: ToolDefinition = {
  name: "Glob",
  description:
    "Fast file pattern matching tool. Supports glob patterns like **/*.ts.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern (e.g. "**/*.ts").' },
      path: { type: "string", description: "Directory to search in." },
      limit: {
        type: "number",
        description: "Maximum number of files to return. Default: 200.",
        default: DEFAULT_LIMIT,
      },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = input.pattern as string;
    const cwd = context.cwd ?? process.cwd();
    const basePath = resolveToolPath((input.path as string) ?? cwd, cwd);
    const limit = (input.limit as number) ?? DEFAULT_LIMIT;

    try {
      const sandboxError = await sandboxPathError(basePath, cwd, "read", context.settings);
      if (sandboxError) {
        return {
          content: [{ type: "text" as const, text: sandboxError }],
          isError: true,
        };
      }

      const rgFiles = await tryRipgrepFiles(basePath, pattern, limit);
      const files =
        rgFiles !== null ? rgFiles : await walkGlob(basePath, pattern, limit);
      const sorted = files.sort().slice(0, limit);

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

function findRipgrep(): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(finder, ["rg"], {
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const matches = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const first =
      process.platform === "win32"
        ? matches.find((line) => line.toLowerCase().endsWith(".exe")) ?? matches[0]
        : matches[0];
    return first || null;
  } catch {
    return null;
  }
}

/**
 * List files via `rg --files`, which respects .gitignore and skips heavy
 * directories cheaply. Returns null when ripgrep is unavailable so the caller
 * falls back to the pure-Node walker.
 */
async function tryRipgrepFiles(
  basePath: string,
  pattern: string,
  limit: number
): Promise<string[] | null> {
  const rgPath = findRipgrep();
  if (!rgPath) return null;

  const args = ["--files"];
  // Surface tracked dotfiles (e.g. .github/) inside repos while still honouring
  // .gitignore, so .venv / node_modules stay excluded.
  const gitignore = join(basePath, ".gitignore");
  if (existsSync(join(basePath, ".git")) || existsSync(gitignore)) {
    args.push("--hidden");
  }
  // ripgrep only discovers .gitignore reliably when the search root belongs to
  // a Git repository. Explicitly load a root ignore file for arbitrary roots.
  if (existsSync(gitignore)) args.push("--ignore-file", gitignore);
  for (const directory of SKIP_DIRS) args.push("--glob", `!${directory}/**`);
  args.push(".");

  // A positive ripgrep --glob overrides ignore files. Keep rg responsible for
  // discovery/ignore semantics and apply the caller's include pattern here.
  const matchesPattern = globToRegex(pattern);

  return new Promise<string[] | null>((resolvePromise) => {
    const files: string[] = [];
    let buffer = "";
    let settled = false;
    let stopped = false;

    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    let child;
    try {
      child = spawn(rgPath, args, {
        cwd: basePath,
        windowsHide: true,
        // stderr -> ignore: an unread pipe could deadlock rg on noisy errors.
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      stopped = true;
      child.kill("SIGKILL");
    }, RG_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = normalizeRgPath(raw.trim());
        if (line && matchesPattern.test(line.replace(/\\/g, "/"))) files.push(line);
        if (files.length >= limit) {
          stopped = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          return;
        }
      }
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (!stopped && buffer) {
        const line = normalizeRgPath(buffer.trim());
        if (line && matchesPattern.test(line.replace(/\\/g, "/"))) files.push(line);
      }
      if (stopped || code === 0 || code === 1 || code === null) {
        finish(files.slice(0, limit));
      } else {
        finish(null);
      }
    });
  });
}

// rg emits "./relative/path" on some platforms; strip the leading "./".
function normalizeRgPath(p: string): string {
  if (!p) return p;
  return p.replace(/^\.[\\/]/, "");
}

async function walkGlob(
  dir: string,
  pattern: string,
  limit: number
): Promise<string[]> {
  const results: string[] = [];
  const regex = globToRegex(pattern);

  const st = await stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return results;

  async function walk(current: string): Promise<void> {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      // Skip hidden and well-known heavy directories.
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(dir, fullPath);
        // Normalize to forward slashes so glob matching is platform-stable.
        const normalized = rel.split(/[\\/]/).join("/");
        if (regex.test(normalized)) {
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
    // `**/` matches zero or more leading directory segments, so `**/*.ts`
    // also matches files at the root (e.g. `keep.ts`).
    .replace(/\*\*\//g, "{{GLOBSTARSLASH}}")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTARSLASH\}\}/g, "(?:.*/)?")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`);
}
