import type { ChildProcess } from "node:child_process";
import type { Settings, ToolDefinition } from "@openharness/core";
import {
  createShellProcess,
  SandboxUnavailableError,
  signalProcessTree,
} from "@openharness/sandbox";

// Matches the Python implementation's output cap.
const MAX_OUTPUT_CHARS = 12000;

// After a timeout we kill the process and wait briefly to collect any final
// output, mirroring the Python implementation's 2s remaining-output read.
const TIMEOUT_GRACE_MS = 2000;

export const bashTool: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a shell command. On Windows this prefers bash.exe when usable and falls back to PowerShell/cmd when bash.exe is unavailable. Use for git, npm, docker, etc.",
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

    const result = await runShell(command, cwd, timeout, {
      sessionId: context.sessionId,
      settings: context.settings,
      abortSignal: context.abortSignal,
    });

    if (result.interrupted) {
      return {
        content: [{ type: "text", text: formatInterruptedOutput(result.output) }],
        isError: true,
      };
    }

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
  interrupted: boolean;
}

function runShell(
  command: string,
  cwd: string,
  timeout: number,
  options: { sessionId?: string; settings?: Settings; abortSignal?: AbortSignal } = {},
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    let child: Awaited<ReturnType<typeof createShellProcess>> | undefined;
    let buffer = "";
    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string) => {
      buffer += decodeShellChunk(chunk);
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.abortSignal?.removeEventListener("abort", interrupt);
      resolve({ output: buffer, code, timedOut, interrupted });
    };

    const interrupt = () => {
      if (settled) return;
      interrupted = true;
      if (!child) {
        finish(null);
        return;
      }
      killTree(child);
      child.stdout?.pause();
      child.stderr?.pause();
      finish(child.exitCode);
    };

    if (options.abortSignal?.aborted) {
      interrupt();
      return;
    }
    options.abortSignal?.addEventListener("abort", interrupt, { once: true });

    createShellProcess(command, {
      cwd,
      sessionId: options.sessionId,
      settings: options.settings,
      stdio: ["ignore", "pipe", "pipe"],
    }).then((startedChild) => {
    const runningChild = startedChild;
    child = runningChild;
    if (options.abortSignal?.aborted || settled) {
      killTree(runningChild);
      return;
    }

    runningChild.stdout?.on("data", append);
    runningChild.stderr?.on("data", append);

    timer = setTimeout(() => {
      // On timeout keep whatever output has accumulated rather than discarding
      // it. Kill the whole process tree so grandchildren (e.g. `sleep`) don't
      // hold the stdout pipe open, then resolve after a short grace window even
      // if `close` never fires (a leaked grandchild keeping the pipe alive).
      timedOut = true;
      killTree(runningChild);
      graceTimer = setTimeout(() => {
        // Pause before resolving to stop new OS reads; data already delivered
        // via 'data' events (in buffer) is captured; late OS-buffered bytes are
        // deliberately dropped — this is a timeout path, partial output is expected.
        runningChild.stdout?.pause();
        runningChild.stderr?.pause();
        finish(runningChild.exitCode);
      }, TIMEOUT_GRACE_MS);
      // Don't keep the event loop alive solely for the grace timer.
      graceTimer.unref?.();
    }, timeout);

    runningChild.on("error", (err) => {
      append(`${err.message}\n`);
      finish(null);
    });

    runningChild.on("close", (code) => {
      finish(code);
    });
    }).catch((err) => {
      if (settled) return;
      const text = err instanceof SandboxUnavailableError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      append(text);
      finish(null);
    });
  });
}

function killTree(child: ChildProcess): void {
  signalProcessTree(child, "SIGKILL");
}

function normalize(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

export function decodeShellChunk(chunk: Buffer | string): string {
  if (typeof chunk === "string") return chunk;

  // Windows WSL launch errors are commonly emitted as UTF-16LE. Decoding them
  // as UTF-8 turns actionable messages like E_ACCESS_DENIED into mojibake.
  if (looksLikeUtf16Le(chunk)) {
    return chunk.toString("utf16le");
  }
  return chunk.toString("utf8");
}

export function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const sampleLength = Math.min(buffer.length, 200);
  let oddNulls = 0;
  let evenNulls = 0;

  for (let i = 0; i < sampleLength; i++) {
    if (buffer[i] !== 0) continue;
    if (i % 2 === 0) {
      evenNulls++;
    } else {
      oddNulls++;
    }
  }

  const pairs = Math.floor(sampleLength / 2);
  return oddNulls > pairs * 0.25 && evenNulls < pairs * 0.05;
}

export function formatOutput(raw: string): string {
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

function formatInterruptedOutput(raw: string): string {
  const parts = ["Command interrupted."];
  const text = formatOutput(raw);
  if (text !== "(no output)") {
    parts.push("", "Partial output:", text);
  }
  return parts.join("\n");
}
