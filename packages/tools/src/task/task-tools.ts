import type { ToolDefinition } from "@openharness/core";

export const taskCreateTool: ToolDefinition = {
  name: "TaskCreate",
  description: "Start a background shell job. Use JobRead, JobWait, and JobCancel with the returned jobId.",
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
          text: "TaskCreate only creates background shell jobs. Use Agent to create a child agent.",
        }],
        isError: true,
      };
    }
    const description = readRequiredString(input.description, "description");
    if ("error" in description) return failed(description.error);
    const command = readRequiredString(input.command, "command");
    if ("error" in command) return failed(command.error);

    try {
      const { getTaskManager } = await import("@openharness/services");
      const task = await getTaskManager({ cwd: context.cwd, sessionId: context.sessionId }).createShellTask({
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
            jobId: task.id,
            jobKind: "shell",
            label: task.description,
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
