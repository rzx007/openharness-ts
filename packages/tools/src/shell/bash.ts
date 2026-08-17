import type { ToolDefinition } from "@openharness/core";
import {
  describeHostShellLauncher,
  resolveHostShellLauncher,
  type HostShellLauncher,
} from "@openharness/sandbox";
import { defaultShellExecutor } from "./executor.js";
import { formatOutput } from "./output.js";
import type { ShellExecSpec, ShellExecutor } from "./types.js";

export { decodeShellChunk, formatOutput, looksLikeUtf16Le } from "./output.js";

export function createBashTool(executor: ShellExecutor = defaultShellExecutor): ToolDefinition {
  return {
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
      const spec = await executor.resolve({
        command: input.command as string,
        timeoutMs: input.timeout as number | undefined,
        workdir: input.workdir as string | undefined,
      }, {
        cwd: context.cwd,
        sessionId: context.sessionId,
        settings: context.settings,
      });
      const dialectMismatch = diagnoseShellCommand(spec);
      if (dialectMismatch) {
        return {
          content: [{ type: "text", text: formatShellDialectMismatch(dialectMismatch) }],
          isError: true,
        };
      }

      const result = await executor.run(spec, context.abortSignal);
      if (result.status === "interrupted") {
        return {
          content: [{ type: "text", text: formatInterruptedOutput(result.output, spec.maxOutputChars) }],
          isError: true,
        };
      }
      if (result.status === "timed_out") {
        return {
          content: [{
            type: "text",
            text: formatTimeoutOutput(result.output, spec.timeoutMs, spec.maxOutputChars),
          }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: formatOutput(result.output, spec.maxOutputChars) }],
        isError: result.status === "failed",
      };
    },
  };
}

export const bashTool: ToolDefinition = createBashTool();

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
  spec: ShellExecSpec,
): ShellDialectMismatch | null {
  const shell = spec.hostShell;
  if (shell.kind === "bash" || shell.kind === "posix-sh") return null;
  if (spec.runner.mode === "sandbox-active" && spec.runner.backend === "docker") return null;

  const problems = diagnoseShellDialectMismatch(spec.command, shell);
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

function formatTimeoutOutput(raw: string, timeout: number, maxOutputChars: number): string {
  const parts = [`Command timed out after ${timeout} ms.`];
  const text = formatOutput(raw, maxOutputChars);
  if (text !== "(no output)") {
    parts.push("", "Partial output:", text);
  }
  return parts.join("\n");
}

function formatInterruptedOutput(raw: string, maxOutputChars: number): string {
  const parts = ["Command interrupted."];
  const text = formatOutput(raw, maxOutputChars);
  if (text !== "(no output)") {
    parts.push("", "Partial output:", text);
  }
  return parts.join("\n");
}
