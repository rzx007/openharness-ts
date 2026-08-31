import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { getConfigDir, getProjectMemoryDir, type Settings } from "@openharness/core";
import {
  hostPathToContainerPath,
  setActiveSandboxSession,
  type SandboxSession,
} from "@openharness/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grepTool } from "../../search/grep.js";
import { fileEditTool } from "../edit.js";
import { globTool } from "../glob.js";
import { fileOperationsFor } from "../operations.js";
import { fileReadTool } from "../read.js";
import { fileWriteTool } from "../write.js";

describe("fileOperationsFor", () => {
  afterEach(() => {
    setActiveSandboxSession(null);
  });

  it("routes Glob and Grep through the active Docker session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "oh-file-ops-search-"));
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    try {
      const session = fakeDockerSession(cwd, (argv, options) => {
        calls.push({ argv, cwd: options.cwd });
        if (argv[0] === "rg" && argv.includes("--files")) {
          return makeChild({ stdout: "./src/a.ts\n./README.md\n" });
        }
        return makeChild({ stdout: "notes.txt:1:needle\n" });
      });
      setActiveSandboxSession(session, { cwd, sessionId: "s1" });

      const context = { cwd, sessionId: "s1", settings: dockerSettings() };
      const globResult = await globTool.execute!(
        { pattern: "**/*.ts", path: cwd },
        context,
      );
      const grepResult = await grepTool.execute!(
        { pattern: "needle", path: cwd },
        context,
      );

      expect((globResult.content[0] as any).text).toBe("src/a.ts");
      expect((grepResult.content[0] as any).text).toBe("notes.txt:1:needle");
      expect(calls.map((call) => call.argv[0])).toEqual(["rg", "rg"]);
      expect(calls.every((call) => call.cwd === cwd)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes Read, Write, and Edit through container file helpers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "oh-file-ops-rw-"));
    const file = join(cwd, "notes.txt");
    const helperRequests: Array<Record<string, unknown>> = [];
    let content = "old text";
    try {
      const session = fakeDockerSession(cwd, (argv) => {
        expect(argv.slice(0, 2)).toEqual(["node", "-e"]);
        return makeChild({
          onStdin: (raw) => {
            const input = JSON.parse(raw || "{}") as Record<string, unknown>;
            helperRequests.push(input);
            if (input.op === "stat") {
              return JSON.stringify({ isFile: true, isDirectory: false });
            }
            if (input.op === "readText") {
              return JSON.stringify({ content });
            }
            if (input.op === "writeText") {
              content = String(input.content ?? "");
              return JSON.stringify({ ok: true });
            }
            throw new Error(`unexpected helper op ${String(input.op)}`);
          },
        });
      });
      setActiveSandboxSession(session, { cwd, sessionId: "s1" });

      const context = { cwd, sessionId: "s1", settings: dockerSettings() };
      const readResult = await fileReadTool.execute!({ file_path: file }, context);
      const writeResult = await fileWriteTool.execute!(
        { file_path: file, content: "new text" },
        context,
      );
      const editResult = await fileEditTool.execute!(
        { file_path: file, old_string: "new", new_string: "newer" },
        context,
      );

      expect((readResult.content[0] as any).text).toBe("1: old text");
      expect(writeResult.isError).toBeFalsy();
      expect(editResult.isError).toBeFalsy();
      expect(content).toBe("newer text");
      expect(helperRequests.map((request) => request.op)).toEqual([
        "stat",
        "readText",
        "writeText",
        "readText",
        "writeText",
      ]);
      expect(helperRequests.every((request) => request.path === hostPathToContainerPath(file, cwd))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Write and Edit for managed persistence paths without blocking ordinary project files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "oh-file-ops-managed-"));
    const configDir = await mkdtemp(join(tmpdir(), "oh-file-ops-config-"));
    const oldConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = configDir;
    try {
      const userProfile = join(getConfigDir(), "USER.md");
      const memoryEntry = join(getProjectMemoryDir(cwd), "entry.md");
      const projectUserFile = join(cwd, "USER.md");
      await mkdir(getProjectMemoryDir(cwd), { recursive: true });
      await writeFile(userProfile, "existing user preference\n", "utf-8");
      await writeFile(memoryEntry, "existing project memory\n", "utf-8");

      const context = { cwd, settings: hostSettings() };
      const userResult = await fileWriteTool.execute!(
        { file_path: userProfile, content: "overwritten" },
        context,
      );
      const memoryResult = await fileEditTool.execute!(
        { file_path: memoryEntry, old_string: "existing", new_string: "changed" },
        context,
      );
      const ordinaryResult = await fileWriteTool.execute!(
        { file_path: projectUserFile, content: "project documentation" },
        context,
      );

      expect(userResult.isError).toBe(true);
      expect(memoryResult.isError).toBe(true);
      expect(ordinaryResult.isError).not.toBe(true);
      expect(await readFile(userProfile, "utf-8")).toBe("existing user preference\n");
      expect(await readFile(memoryEntry, "utf-8")).toBe("existing project memory\n");
      expect(await readFile(projectUserFile, "utf-8")).toBe("project documentation");
    } finally {
      if (oldConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = oldConfigDir;
      await rm(cwd, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("fails closed when Docker sandbox is required but no session is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "oh-file-ops-no-session-"));
    try {
      expect(() => fileOperationsFor({ cwd, settings: dockerSettings() })).toThrow(
        /Docker sandbox session is not running/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function dockerSettings(): Settings {
  return {
    model: "m",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    sandbox: {
      enabled: true,
      backend: "docker",
      failIfUnavailable: true,
    },
  };
}

function hostSettings(): Settings {
  return {
    model: "m",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    sandbox: { enabled: false },
  };
}

function fakeDockerSession(
  cwd: string,
  execCommand: FakeExecCommand,
): SandboxSession {
  return {
    backend: "docker",
    cwd,
    active: true,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    execCommand: async (argv, options) => execCommand(argv, options),
  };
}

type FakeExecCommand = (
  argv: string[],
  options: Parameters<NonNullable<SandboxSession["execCommand"]>>[1],
) => ChildProcess;

function makeChild(options: {
  stdout?: string;
  stderr?: string;
  code?: number;
  onStdin?: (stdin: string) => string;
}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdinText = "";
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinText += chunk.toString();
      callback();
    },
    final(callback) {
      setImmediate(() => {
        try {
          const output = options.onStdin?.(stdinText) ?? options.stdout ?? "";
          if (output) stdout.write(output);
          if (options.stderr) stderr.write(options.stderr);
          stdout.end();
          stderr.end();
          setImmediate(() => {
            child.emit("close", options.code ?? 0);
          });
        } catch (error) {
          stderr.end(error instanceof Error ? error.message : String(error));
          stdout.end();
          setImmediate(() => {
            child.emit("close", 1);
          });
        }
      });
      callback();
    },
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);
  return child;
}
