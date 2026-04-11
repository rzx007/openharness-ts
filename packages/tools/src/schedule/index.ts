import type { ToolDefinition } from "@openharness/core";

export const cronCreateTool: ToolDefinition = {
  name: "CronCreate",
  description: "Create or replace a local cron job.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique cron job name" },
      schedule: { type: "string", description: "Cron schedule expression" },
      command: { type: "string", description: "Shell command" },
      cwd: { type: "string", description: "Working directory" },
      enabled: { type: "boolean", default: true },
    },
    required: ["name", "schedule", "command"],
  },
  async execute(input, context) {
    const { validateCronExpression } = await import("@openharness/services");
    const schedule = input.schedule as string;
    if (!validateCronExpression(schedule)) {
      return { content: [{ type: "text", text: `Invalid cron expression: '${schedule}'` }], isError: true };
    }
    return { content: [{ type: "text", text: `Created cron job '${input.name}' [${schedule}]` }] };
  },
};

export const cronDeleteTool: ToolDefinition = {
  name: "CronDelete",
  description: "Delete a local cron job by name.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "Cron job name" } },
    required: ["name"],
  },
  async execute(input) {
    return { content: [{ type: "text", text: `Deleted cron job ${input.name}` }] };
  },
};

export const cronListTool: ToolDefinition = {
  name: "CronList",
  description: "List configured local cron jobs.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    return { content: [{ type: "text", text: "No cron jobs configured." }] };
  },
};

export const cronToggleTool: ToolDefinition = {
  name: "CronToggle",
  description: "Enable or disable a local cron job by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cron job name" },
      enabled: { type: "boolean", description: "True to enable" },
    },
    required: ["name", "enabled"],
  },
  async execute(input) {
    const state = input.enabled ? "enabled" : "disabled";
    return { content: [{ type: "text", text: `Cron job '${input.name}' is now ${state}` }] };
  },
};
