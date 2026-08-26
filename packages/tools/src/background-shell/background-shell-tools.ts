import type { ToolDefinition } from "@openharness/core";

export const backgroundShellCreateTool: ToolDefinition = {
  name: "BackgroundShellCreate",
  description: "Start a detached background shell process. Use JobRead, JobWait, and JobCancel with the returned jobId.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short job description" },
      command: { type: "string", description: "Shell command to run in the background" },
    },
    required: ["description", "command"],
  },
  async execute(input, context) {
    if (input.type !== undefined || input.prompt !== undefined || input.model !== undefined) {
      return {
        content: [{
          type: "text",
          text: "BackgroundShellCreate only creates detached shell processes. Use Agent to create a child agent.",
        }],
        isError: true,
      };
    }
    const description = readRequiredString(input.description, "description");
    if ("error" in description) return failed(description.error);
    const command = readRequiredString(input.command, "command");
    if ("error" in command) return failed(command.error);

    if (!context.sessionId) return failed("Background shell jobs require a durable session.");
    if (!context.backgroundShell) return failed("Background shell host is not configured.");

    try {
      const created = await context.backgroundShell.create({
        command: command.value,
        description: description.value,
        cwd: context.cwd,
        sessionId: context.sessionId,
        settings: context.settings,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            kind: "job",
            action: "created",
            jobId: created.jobId,
            jobKind: "shell",
            label: created.label,
          }),
        }],
      };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  },
};

function readRequiredString(value: unknown, name: string): { value: string } | { error: string } {
  return typeof value === "string" && value.trim()
    ? { value: value.trim() }
    : { error: `${name} is required.` };
}

function failed(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
