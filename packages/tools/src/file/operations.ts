import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Settings, ToolContext } from "@openharness/core";
import {
  createProcess,
  getActiveSandboxSession,
  hostPathToContainerPath,
  resolveSandboxPolicy,
  SandboxUnavailableError,
} from "@openharness/sandbox";

export interface FileEntry {
  name: string;
  isDirectory: boolean;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface GrepOptions {
  include?: string;
  caseSensitive: boolean;
  limit: number;
}

export interface FileOperations {
  stat(path: string): Promise<FileStat>;
  listDir(path: string): Promise<FileEntry[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  glob(basePath: string, pattern: string, limit: number): Promise<string[] | null>;
  grep(basePath: string, pattern: string, options: GrepOptions): Promise<string[] | null>;
}

export function fileOperationsFor(context: ToolContext): FileOperations {
  const cwd = context.cwd ?? process.cwd();
  const settings = context.settings;
  const policy = resolveSandboxPolicy({ cwd, sessionId: context.sessionId, settings });
  if (policy.enabled && policy.backend === "docker") {
    const session = getActiveSandboxSession({
      cwd: policy.scope.cwd,
      sessionId: policy.scope.sessionId,
    });
    if (session?.backend === "docker" && session.active && session.execCommand) {
      return new DockerFileOperations({ cwd, settings, sessionId: context.sessionId, signal: context.abortSignal });
    }
    if (policy.failClosed) {
      throw new SandboxUnavailableError("Docker sandbox session is not running");
    }
  }
  return new HostFileOperations();
}

export class HostFileOperations implements FileOperations {
  async stat(path: string): Promise<FileStat> {
    const item = await stat(path);
    return { isFile: item.isFile(), isDirectory: item.isDirectory() };
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  }

  async readText(path: string): Promise<string> {
    return await readFile(path, "utf-8");
  }

  async writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }

  async glob(basePath: string, pattern: string, limit: number): Promise<string[] | null> {
    const rgPath = findRipgrep();
    if (!rgPath) return null;

    const args = ["--files"];
    const gitignore = join(basePath, ".gitignore");
    if (existsSync(join(basePath, ".git")) || existsSync(gitignore)) args.push("--hidden");
    if (existsSync(gitignore)) args.push("--ignore-file", gitignore);
    for (const directory of SKIP_DIRS) args.push("--glob", `!${directory}/**`);
    args.push(".");

    const result = await runHostProcess(rgPath, args, { cwd: basePath });
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
    return filterGlobOutput(result.stdout, pattern, limit);
  }

  async grep(basePath: string, pattern: string, options: GrepOptions): Promise<string[] | null> {
    const rgPath = findRipgrep();
    if (!rgPath) return null;
    const args = grepArgs(basePath, pattern, options);
    const result = await runHostProcess(rgPath, args, { cwd: basePath });
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
    return filterGrepOutput(result.stdout, options.limit);
  }
}

export class DockerFileOperations implements FileOperations {
  constructor(private readonly options: {
    cwd: string;
    settings?: Settings;
    sessionId?: string;
    signal?: AbortSignal;
  }) {}

  async stat(path: string): Promise<FileStat> {
    return await this.nodeHelper<FileStat>({ op: "stat", path: this.containerPath(path) });
  }

  async listDir(path: string): Promise<FileEntry[]> {
    return await this.nodeHelper<FileEntry[]>({ op: "listDir", path: this.containerPath(path) });
  }

  async readText(path: string): Promise<string> {
    const result = await this.nodeHelper<{ content: string }>({ op: "readText", path: this.containerPath(path) });
    return result.content;
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.nodeHelper<{ ok: true }>({ op: "writeText", path: this.containerPath(path), content });
  }

  async glob(basePath: string, pattern: string, limit: number): Promise<string[] | null> {
    const args = ["rg", "--files"];
    args.push("--hidden");
    for (const directory of SKIP_DIRS) args.push("--glob", `!${directory}/**`);
    args.push(".");
    const result = await this.run(args, basePath);
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
    return filterGlobOutput(result.stdout, pattern, limit);
  }

  async grep(basePath: string, pattern: string, options: GrepOptions): Promise<string[] | null> {
    const result = await this.run(["rg", ...grepArgs(basePath, pattern, options)], basePath);
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
    return filterGrepOutput(result.stdout, options.limit);
  }

  private containerPath(path: string): string {
    return hostPathToContainerPath(path, this.options.cwd);
  }

  private async nodeHelper<T>(input: Record<string, unknown>): Promise<T> {
    const result = await this.run(["node", "-e", FILE_HELPER_SCRIPT], this.options.cwd, JSON.stringify(input));
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `file helper exited with code ${result.exitCode}`);
    }
    return JSON.parse(result.stdout) as T;
  }

  private async run(argv: string[], cwd: string, stdin?: string): Promise<ProcessResult> {
    const child = await createProcess(argv, {
      cwd,
      settings: this.options.settings,
      sessionId: this.options.sessionId,
      signal: this.options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result = collectProcess(child);
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
    return await result;
  }
}

export async function walkGlob(
  dir: string,
  pattern: string,
  limit: number,
  operations: FileOperations = new HostFileOperations(),
): Promise<string[]> {
  const results: string[] = [];
  const regex = globToRegex(pattern);

  const st = await operations.stat(dir).catch(() => null);
  if (!st || !st.isDirectory) return results;

  async function walk(current: string): Promise<void> {
    if (results.length >= limit) return;
    let entries: FileEntry[];
    try {
      entries = await operations.listDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory) {
        await walk(fullPath);
      } else {
        const rel = relative(dir, fullPath);
        const normalized = rel.split(/[\\/]/).join("/");
        if (regex.test(normalized)) results.push(rel);
      }
    }
  }

  await walk(dir);
  return results;
}

export async function fallbackGrep(
  basePath: string,
  pattern: string,
  include: string | undefined,
  caseSensitive: boolean,
  limit: number,
  operations: FileOperations = new HostFileOperations(),
): Promise<string[]> {
  const flags = caseSensitive ? "" : "i";
  const regex = new RegExp(pattern, flags);
  const includeRegex = include ? globToRegex(include) : null;
  const results: string[] = [];

  const matchLines = (content: string, displayPath: string): boolean => {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) continue;
      if (regex.test(line)) {
        results.push(`${displayPath}:${i + 1}:${line}`);
        if (results.length >= limit) return true;
      }
    }
    return false;
  };

  async function walk(dir: string): Promise<void> {
    const entries = await operations.listDir(dir);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(fullPath);
        if (results.length >= limit) return;
      } else {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        try {
          const content = await operations.readText(fullPath);
          if (content.includes("\0")) continue;
          const rel = relative(basePath, fullPath);
          if (matchLines(content, rel)) return;
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  const st = await operations.stat(basePath);
  if (st.isFile) {
    const content = await operations.readText(basePath);
    matchLines(content, basePath);
  } else {
    await walk(basePath);
  }

  return results;
}

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "{{GLOBSTARSLASH}}")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTARSLASH\}\}/g, "(?:.*/)?")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`);
}

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

const MAX_LINE_BYTES = 64 * 1024;
const FILE_HELPER_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    if (input.op === "stat") {
      const st = fs.statSync(input.path);
      console.log(JSON.stringify({ isFile: st.isFile(), isDirectory: st.isDirectory() }));
    } else if (input.op === "listDir") {
      const entries = fs.readdirSync(input.path, { withFileTypes: true })
        .map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      console.log(JSON.stringify(entries));
    } else if (input.op === "readText") {
      console.log(JSON.stringify({ content: fs.readFileSync(input.path, "utf8") }));
    } else if (input.op === "writeText") {
      fs.mkdirSync(path.dirname(input.path), { recursive: true });
      fs.writeFileSync(input.path, input.content ?? "", "utf8");
      console.log(JSON.stringify({ ok: true }));
    } else {
      throw new Error("unknown file helper op: " + input.op);
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
});
`;

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function findRipgrep(): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(finder, ["rg"], {
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    const matches = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const first = process.platform === "win32"
      ? matches.find((line) => line.toLowerCase().endsWith(".exe")) ?? matches[0]
      : matches[0];
    return first || null;
  } catch {
    return null;
  }
}

function grepArgs(basePath: string, pattern: string, options: GrepOptions): string[] {
  const args = ["--no-heading", "--line-number", "--color", "never"];
  if (existsSync(join(basePath, ".git")) || existsSync(join(basePath, ".gitignore"))) args.push("--hidden");
  if (!options.caseSensitive) args.push("-i");
  if (options.include) args.push("--glob", options.include);
  args.push("--", pattern, ".");
  return args;
}

function filterGlobOutput(stdout: string, pattern: string, limit: number): string[] {
  const matchesPattern = globToRegex(pattern);
  return stdout
    .split(/\r?\n/)
    .map((line) => normalizeRgPath(line.trim()))
    .filter((line) => line && matchesPattern.test(line.replace(/\\/g, "/")))
    .slice(0, limit);
}

function filterGrepOutput(stdout: string, limit: number): string[] {
  const matches: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf-8") > MAX_LINE_BYTES) continue;
    matches.push(line.trim());
    if (matches.length >= limit) break;
  }
  return matches;
}

function normalizeRgPath(path: string): string {
  return path.replace(/^\.[\\/]/, "");
}

function runHostProcess(command: string, args: string[], options: { cwd: string }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = execFileSync;
    try {
      const stdout = child(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      resolve({ exitCode: 0, stdout, stderr: "" });
    } catch (error) {
      const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
      resolve({
        exitCode: typeof err.status === "number" ? err.status : -1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      });
    }
  });
}

function collectProcess(child: import("node:child_process").ChildProcess): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
