import type { ToolDefinition } from "@openharness/core";

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

    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);

      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
      });

      const output = [stdout, stderr].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: output || "(no output)" }],
      };
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: output }],
        isError: true,
      };
    }
  },
};
