import type { AgentCronEffects, ToolContext, ToolDefinition, ToolResult } from "@openharness/core";
import { validateCronExpression } from "@openharness/services";

function cronHost(context: ToolContext): AgentCronEffects | undefined {
  return context.agent?.effects.cron;
}

function unavailable(): ToolResult {
  return {
    content: [{ type: "text", text: "This host does not provide persistent scheduled commands." }],
    isError: true,
  };
}

export const cronCreateTool: ToolDefinition = {
  name: "CronCreate",
  description: "Create or replace a persistent scheduled command.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique job name" },
      schedule: { type: "string", description: "Five-field cron expression" },
      command: { type: "string", description: "Shell command to run" },
      cwd: { type: "string", description: "Working directory" },
      timezone: { type: "string", description: "Optional IANA timezone" },
      enabled: { type: "boolean", default: true },
    },
    required: ["name", "schedule", "command"],
  },
  async execute(input, context) {
    const host = cronHost(context);
    if (!host) return unavailable();
    const expression = String(input.schedule ?? "");
    if (!validateCronExpression(expression)) {
      return {
        content: [{ type: "text", text: `Invalid cron expression: '${expression}'. Expected 5 fields.` }],
        isError: true,
      };
    }
    try {
      const job = await host.save({
        name: String(input.name ?? ""),
        expression,
        command: String(input.command ?? ""),
        cwd: typeof input.cwd === "string" ? input.cwd : context.cwd,
        timezone: typeof input.timezone === "string" ? input.timezone : undefined,
        enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      });
      return { content: [{ type: "text", text: `Saved cron job '${job.name}' (${job.enabled ? "enabled" : "disabled"}).` }] };
    } catch (error) {
      return failed(error);
    }
  },
};

export const cronDeleteTool: ToolDefinition = {
  name: "CronDelete",
  description: "Delete a persistent scheduled command.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  async execute(input, context) {
    const host = cronHost(context);
    if (!host) return unavailable();
    try {
      await host.remove(String(input.name ?? ""));
      return { content: [{ type: "text", text: `Deleted cron job '${input.name}'.` }] };
    } catch (error) {
      return failed(error);
    }
  },
};

export const cronListTool: ToolDefinition = {
  name: "CronList",
  description: "List persistent scheduled commands.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, context) {
    const host = cronHost(context);
    if (!host) return unavailable();
    try {
      const jobs = await host.list();
      if (jobs.length === 0) return { content: [{ type: "text", text: "No cron jobs configured." }] };
      return {
        content: [{
          type: "text",
          text: jobs.map((job) => `${job.name} [${job.expression}] ${job.enabled ? "enabled" : "disabled"} cmd=${job.command}`).join("\n"),
        }],
      };
    } catch (error) {
      return failed(error);
    }
  },
};

export const cronToggleTool: ToolDefinition = {
  name: "CronToggle",
  description: "Enable or disable a persistent scheduled command.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, enabled: { type: "boolean" } },
    required: ["name", "enabled"],
  },
  async execute(input, context) {
    const host = cronHost(context);
    if (!host) return unavailable();
    try {
      const job = await host.setEnabled(String(input.name ?? ""), Boolean(input.enabled));
      return { content: [{ type: "text", text: `Cron job '${job.name}' is now ${job.enabled ? "enabled" : "disabled"}.` }] };
    } catch (error) {
      return failed(error);
    }
  },
};

export const remoteTriggerTool: ToolDefinition = {
  name: "RemoteTrigger",
  description: "Run a persistent scheduled command now and return its saved output.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  async execute(input, context) {
    const host = cronHost(context);
    if (!host) return unavailable();
    try {
      const run = await host.trigger(String(input.name ?? ""));
      const text = run.output ?? run.error ?? "(no output)";
      return {
        content: [{ type: "text", text }],
        ...(run.status !== "succeeded" ? { isError: true } : {}),
      };
    } catch (error) {
      return failed(error);
    }
  },
};

function failed(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}
