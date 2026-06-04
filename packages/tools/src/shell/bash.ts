import { spawn, execFile } from "node:child_process";
import type { ToolDefinition } from "@openharness/core";

// Matches the Python implementation's output cap.
const MAX_OUTPUT_CHARS = 12000;

// After a timeout we kill the process and wait briefly to collect any final
// output, mirroring the Python implementation's 2s remaining-output read.
const TIMEOUT_GRACE_MS = 2000;

export const bashTool: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a bash command in a persistent shell session. Use for git, npm, docker, etc.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute." },
      timeout: {
        type: "number",
        description: "Optional timeout in milliseconds.",
      },
      workdir: {
        type: "string",
        description: "Working directory for the command.",
      },
    },
    required: ["command"],
  },
  async execute(input, context) {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? 120_000;
    const cwd = (input.workdir as string) ?? context.cwd;

    const result = await runShell(command, cwd, timeout);

    if (result.timedOut) {
      return {
        content: [
          {
            type: "text",
            text: formatTimeoutOutput(result.output, timeout),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: formatOutput(result.output) }],
      isError: result.code !== 0,
    };
  },
};

interface ShellResult {
  output: string;
  code: number | null;
  timedOut: boolean;
}

function runShell(
  command: string,
  cwd: string,
  timeout: number
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const shell = process.platform === "win32" ? "bash.exe" : "/bin/sh";
    const child = spawn(shell, ["-c", command], {
      cwd,
      windowsHide: true,
      // On POSIX, run in its own process group so we can signal the whole tree
      // (the shell plus any children it spawned) on timeout.
      detached: process.platform !== "win32",
      // Merge stderr into stdout ordering at the buffer level (collected below).
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string) => {
      buffer += chunk.toString();
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ output: buffer, code, timedOut });
    };

    const timer = setTimeout(() => {
      // On timeout keep whatever output has accumulated rather than discarding
      // it. Kill the whole process tree so grandchildren (e.g. `sleep`) don't
      // hold the stdout pipe open, then resolve after a short grace window even
      // if `close` never fires (a leaked grandchild keeping the pipe alive).
      timedOut = true;
      killTree(child.pid);
      graceTimer = setTimeout(() => finish(child.exitCode), TIMEOUT_GRACE_MS);
      // Don't keep the event loop alive solely for the grace timer.
      graceTimer.unref?.();
    }, timeout);

    child.on("error", (err) => {
      append(`${err.message}\n`);
      finish(null);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill /T terminates the process and its descendants.
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
    return;
  }
  try {
    // Negative pid signals the whole process group (created via `detached`).
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function normalize(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

function formatOutput(raw: string): string {
  const text = normalize(raw);
  if (!text) return "(no output)";
  if (text.length > MAX_OUTPUT_CHARS) {
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]...`;
  }
  return text;
}

function formatTimeoutOutput(raw: string, timeout: number): string {
  const parts = [`Command timed out after ${timeout} ms.`];
  const text = formatOutput(raw);
  if (text !== "(no output)") {
    parts.push("", "Partial output:", text);
  }
  return parts.join("\n");
}
