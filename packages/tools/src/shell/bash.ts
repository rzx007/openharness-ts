import type { ChildProcess } from "node:child_process";
import type { Settings, ToolDefinition } from "@openharness/core";
import {
  createShellProcess,
  describeHostShellLauncher,
  getActiveSandboxSession,
  normalizeSandboxConfig,
  resolveHostShellLauncher,
  SandboxUnavailableError,
  signalProcessTree,
  type HostShellLauncher,
} from "@openharness/sandbox";

// Matches the Python implementation's output cap.
const MAX_OUTPUT_CHARS = 12000;

// After a timeout we kill the process and wait briefly to collect any final
// output, mirroring the Python implementation's 2s remaining-output read.
const TIMEOUT_GRACE_MS = 2000;

export const bashTool: ToolDefinition = {
  name: "Bash",
  description:
    "Execute a shell command using the environment's active shell. On Windows this may be bash.exe, PowerShell, or cmd; check the Environment shell facts before choosing syntax. Use for git, npm, docker, etc.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
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
    const dialectMismatch = diagnoseShellCommand(command, {
      cwd,
      sessionId: context.sessionId,
      settings: context.settings,
    });
    if (dialectMismatch) {
      return {
        content: [{ type: "text", text: formatShellDialectMismatch(dialectMismatch) }],
        isError: true,
      };
    }

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

export interface ShellDialectProblem {
  code: string;
  message: string;
  suggestion: string;
}

export interface ShellDialectMismatch {
  shell: HostShellLauncher;
  problems: ShellDialectProblem[];
}

export function diagnoseShellDialectMismatch(
  command: string,
  shell: HostShellLauncher = resolveHostShellLauncher(),
): ShellDialectProblem[] {
  if (shell.kind === "bash" || shell.kind === "posix-sh") return [];

  const checks: Array<{
    code: string;
    pattern: RegExp;
    message: string;
    suggestion: string;
    shells?: ReadonlyArray<HostShellLauncher["kind"]>;
  }> = [
    {
      code: "dev-null",
      pattern: /\/dev\/null\b/i,
      message: "uses `/dev/null`, which is a POSIX null device path.",
      suggestion: shell.kind === "powershell" ? "Use `$null` in PowerShell." : "Use `NUL` in cmd.exe.",
    },
    {
      code: "posix-temp-path",
      pattern: /(^|[\s"'=])\/tmp(?:\/|\b)/i,
      message: "uses `/tmp`, which is a POSIX temp path.",
      suggestion: shell.kind === "powershell" ? "Use `$env:TEMP` or a Windows path." : "Use `%TEMP%` or a Windows path.",
    },
    {
      code: "posix-root-path",
      pattern: /(^|[\s"'=])\/(?:home|mnt|var|etc|usr|bin)(?:\/|\b)/i,
      message: "uses an absolute POSIX path.",
      suggestion: "Use the workspace path shown in the Environment section or another confirmed Windows path.",
    },
    {
      code: "ls-la",
      pattern: /(^|[;&|]\s*)ls\s+-[A-Za-z]*[al][A-Za-z]*(?:\s|$)/,
      message: "uses `ls -la` style flags, which are Bash/POSIX syntax.",
      suggestion: shell.kind === "powershell" ? "Use `Get-ChildItem -Force`." : "Use `dir /a`.",
    },
    {
      code: "head",
      pattern: /(^|[;&|]\s*)head(?:\s+-\d+|\s+-n\b|\s|$)/,
      message: "uses `head`, which is not a built-in Windows shell command.",
      suggestion: shell.kind === "powershell" ? "Pipe to `Select-Object -First N`." : "Use a cmd-compatible command or run through bash.exe.",
    },
    {
      code: "find-root",
      pattern: /(^|[;&|]\s*)find\s+\/(?:\s|$)/,
      message: "uses POSIX `find /` syntax.",
      suggestion: shell.kind === "powershell" ? "Use `Get-ChildItem -Recurse` from a confirmed directory." : "Use `dir /s` from a confirmed directory.",
    },
    {
      code: "cd-root",
      pattern: /(^|[;&|]\s*)cd\s+\/(?:\s|$)/,
      message: "uses `cd /`, which means filesystem root in POSIX shells.",
      suggestion: "Use a Windows drive path such as `C:\\` or the current workspace path.",
    },
    {
      code: "powershell-control-operator",
      pattern: /(^|\s)(?:&&|\|\|)(?=\s|$)/,
      message: "uses Bash-style `&&` or `||` command chaining.",
      suggestion: "Use separate PowerShell commands or explicit `if ($LASTEXITCODE -eq 0) { ... }` logic.",
      shells: ["powershell"],
    },
  ];

  const problems: ShellDialectProblem[] = [];
  for (const check of checks) {
    if (check.shells && !check.shells.includes(shell.kind)) continue;
    check.pattern.lastIndex = 0;
    if (!check.pattern.test(command)) continue;
    problems.push({
      code: check.code,
      message: check.message,
      suggestion: check.suggestion,
    });
  }
  return problems;
}

function diagnoseShellCommand(
  command: string,
  options: { cwd: string; sessionId?: string; settings?: Settings },
): ShellDialectMismatch | null {
  const shell = resolveHostShellLauncher();
  if (shell.kind === "bash" || shell.kind === "posix-sh") return null;

  const sandbox = normalizeSandboxConfig(options.settings?.sandbox);
  if (sandbox.enabled && sandbox.backend === "docker") {
    const session = getActiveSandboxSession({ cwd: options.cwd, sessionId: options.sessionId });
    if (session?.backend === "docker" && session.active) return null;
  }

  const problems = diagnoseShellDialectMismatch(command, shell);
  return problems.length > 0 ? { shell, problems } : null;
}

function formatShellDialectMismatch(mismatch: ShellDialectMismatch): string {
  const lines = [
    `Shell dialect mismatch: the active shell is ${describeHostShellLauncher(mismatch.shell)}, but this command looks like Bash/POSIX syntax.`,
    "",
    "Problems:",
  ];
  for (const problem of mismatch.problems) {
    lines.push(`- ${problem.message} ${problem.suggestion}`);
  }
  lines.push("", "Rewrite the command using the active shell syntax, or configure/install bash.exe before using Bash syntax.");
  return lines.join("\n");
}

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
