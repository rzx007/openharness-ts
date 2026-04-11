import type { ToolDefinition } from "@openharness/core";

export const cronCreateTool: ToolDefinition = {
  name: "CronCreate",
  description: "Create or replace a local cron job with a standard cron expression.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Unique cron job name" },
      schedule: {
        type: "string",
        description:
          "Cron schedule expression (e.g. '*/5 * * * *' for every 5 minutes)",
      },
      command: { type: "string", description: "Shell command to run when triggered" },
      cwd: { type: "string", description: "Optional working directory override" },
      enabled: { type: "boolean", default: true, description: "Whether the job is active" },
    },
    required: ["name", "schedule", "command"],
  },
  async execute(input) {
    const { getCronScheduler, validateCronExpression } = await import(
      "@openharness/services"
    );
    const schedule = input.schedule as string;
    if (!validateCronExpression(schedule)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid cron expression: '${schedule}'. Expected 5-field cron format (min hour day month weekday).`,
          },
        ],
        isError: true,
      };
    }
    const scheduler = getCronScheduler();
    const job = scheduler.upsertJob({
      name: input.name as string,
      expression: schedule,
      command: input.command as string,
      cwd: input.cwd as string | undefined,
      enabled: (input.enabled as boolean) ?? true,
    });
    const status = job.enabled ? "enabled" : "disabled";
    return {
      content: [
        {
          type: "text",
          text: `Created cron job '${input.name}' [${schedule}] (${status})`,
        },
      ],
    };
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
    const { getCronScheduler } = await import("@openharness/services");
    const scheduler = getCronScheduler();
    const deleted = scheduler.deleteByName(input.name as string);
    if (!deleted) {
      return {
        content: [{ type: "text", text: `Cron job not found: ${input.name}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Deleted cron job ${input.name}` }],
    };
  },
};

export const cronListTool: ToolDefinition = {
  name: "CronList",
  description:
    "List configured local cron jobs with schedule, status, and next run time.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    const { getCronScheduler } = await import("@openharness/services");
    const scheduler = getCronScheduler();
    const jobs = scheduler.listJobs();
    if (!jobs.length) {
      return {
        content: [{ type: "text", text: "No cron jobs configured." }],
      };
    }
    const lines = jobs.map((j) => {
      const state = j.enabled ? "enabled" : "disabled";
      const runState = j.running ? "running" : "idle";
      return `${j.name} [${j.expression}] ${state} ${runState} cmd=${j.command}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
};

export const cronToggleTool: ToolDefinition = {
  name: "CronToggle",
  description: "Enable or disable a local cron job by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cron job name" },
      enabled: { type: "boolean", description: "True to enable, false to disable" },
    },
    required: ["name", "enabled"],
  },
  async execute(input) {
    const { getCronScheduler } = await import("@openharness/services");
    const scheduler = getCronScheduler();
    const job = scheduler.setEnabled(
      input.name as string,
      input.enabled as boolean
    );
    if (!job) {
      return {
        content: [{ type: "text", text: `Cron job not found: ${input.name}` }],
        isError: true,
      };
    }
    const state = job.enabled ? "enabled" : "disabled";
    return {
      content: [
        { type: "text", text: `Cron job '${input.name}' is now ${state}` },
      ],
    };
  },
};

export const remoteTriggerTool: ToolDefinition = {
  name: "RemoteTrigger",
  description: "Trigger a configured local cron job immediately and capture output.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cron job name to trigger" },
    },
    required: ["name"],
  },
  async execute(input) {
    const { getCronScheduler } = await import("@openharness/services");
    const scheduler = getCronScheduler();
    const job = scheduler.findByName(input.name as string);
    if (!job) {
      return {
        content: [{ type: "text", text: `Cron job not found: ${input.name}` }],
        isError: true,
      };
    }
    if (!job.command) {
      return {
        content: [{ type: "text", text: `Cron job '${input.name}' has no command` }],
        isError: true,
      };
    }

    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    try {
      const cwd = job.cwd ?? process.cwd();
      const { stdout, stderr } = await execAsync(job.command, {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      });

      job.lastRun = Date.now();
      job.nextRun = (await import("@openharness/services")).computeNextRunTime(job.expression);
      scheduler["history"].push({
        name: job.name,
        timestamp: Date.now(),
        success: true,
        output: (stdout ?? "").slice(0, 500),
      });

      const output = [stdout, stderr].filter(Boolean).join("\n").slice(0, 5000);
      return {
        content: [
          { type: "text", text: `Triggered '${input.name}':\n${output || "(no output)"}` },
        ],
      };
    } catch (err: any) {
      scheduler["history"].push({
        name: job.name,
        timestamp: Date.now(),
        success: false,
        output: err.message,
      });

      return {
        content: [
          { type: "text", text: `Trigger '${input.name}' failed: ${err.message}` },
        ],
        isError: true,
      };
    }
  },
};
