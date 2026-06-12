import { join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { AutocompleteItem } from "./Autocomplete";

const MAX_FILES = 5000;
const MAX_ITEMS = 10;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "build", "coverage"]);

const cache = new Map<string, string[]>();

export async function listProjectFiles(cwd: string): Promise<string[]> {
  if (cache.has(cwd)) return cache.get(cwd)!;

  let files: string[] = [];
  try {
    const proc = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    files = text.split("\n").filter(Boolean).slice(0, MAX_FILES);
  } catch {
    files = fsWalk(cwd, cwd, 0).slice(0, MAX_FILES);
  }

  cache.set(cwd, files);
  return files;
}

function fsWalk(root: string, dir: string, depth: number): string[] {
  if (depth > 6) return [];
  const entries: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(entry)) {
            entries.push(...fsWalk(root, full, depth + 1));
          }
        } else {
          entries.push(relative(root, full).replace(/\\/g, "/"));
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* skip unreadable directories */ }
  return entries;
}

export function detectAtToken(
  text: string,
): { token: string; atStart: number; atEnd: number } | null {
  // Find the last @ that is at start or preceded by whitespace, followed by non-space chars
  // An @ followed immediately by a space (and not at end) is not a valid token
  const re = /(^|\s)@(\S*)/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m;
  }
  if (!last) return null;
  const token = last[2]!;
  const prefix = last[1]!;
  const matchStart = last.index!;
  const atStart = matchStart + prefix.length;
  const atEnd = atStart + 1 + token.length; // 1 for '@'
  // If token is empty and there is non-whitespace text after the @, return null
  // e.g. "hello @ world" — the @ is followed by space so token="" but it's not at end
  if (token === "" && atEnd < text.length) return null;
  return { token, atStart, atEnd };
}

export function buildAtItems(
  files: string[],
  token: string,
  frecencyScores?: Map<string, number>,
): AutocompleteItem[] {
  const lower = token.toLowerCase();
  const filtered = token === ""
    ? [...files].sort((a, b) => (frecencyScores?.get(b) ?? 0) - (frecencyScores?.get(a) ?? 0))
    : files.filter((f) => f.toLowerCase().includes(lower));
  return filtered.slice(0, MAX_ITEMS).map((f) => ({ id: f, label: f }));
}
