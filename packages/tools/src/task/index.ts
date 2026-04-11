import type { ToolDefinition } from "@openharness/core";

export const taskCreateTool: ToolDefinition = {
  name: "TaskCreate",
  description: "Create a background shell or local-agent task.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", description: "Task type: local_bash or local_agent", default: "local_bash" },
      description: { type: "string", description: "Short task description" },
      command: { type: "string", description: "Shell command for local_bash" },
      prompt: { type: "string", description: "Prompt for local_agent" },
      model: { type: "string", description: "Model override" },
    },
    required: ["description"],
  },
  async execute(input, context) {
    const { getTaskManager } = await import("@openharness/services");
    const mgr = getTaskManager();
    const type = (input.type as string) ?? "local_bash";
    const desc = input.description as string;

    if (type === "local_bash") {
      const command = input.command as string;
      if (!command) {
        return { content: [{ type: "text", text: "command is required for local_bash tasks" }], isError: true };
      }
      const task = await mgr.createShellTask(command, desc, context.cwd);
      return { content: [{ type: "text", text: `Created task ${task.id} (${task.type})` }] };
    }

    if (type === "local_agent") {
      const prompt = input.prompt as string;
      if (!prompt) {
        return { content: [{ type: "text", text: "prompt is required for local_agent tasks" }], isError: true };
      }
      const task = await mgr.createAgentTask(prompt, desc, context.cwd, input.model as string);
      return { content: [{ type: "text", text: `Created task ${task.id} (${task.type})` }] };
    }

    return { content: [{ type: "text", text: `unsupported task type: ${type}` }], isError: true };
  },
};

export const taskGetTool: ToolDefinition = {
  name: "TaskGet",
  description: "Get details for a background task.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string", description: "Task identifier" } },
    required: ["taskId"],
  },
  async execute(input) {
    const { getTaskManager } = await import("@openharness/services");
    const task = getTaskManager().getTask(input.taskId as string);
    if (!task) {
      return { content: [{ type: "text", text: `No task found with ID: ${input.taskId}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
  },
};

export const taskListTool: ToolDefinition = {
  name: "TaskList",
  description: "List background tasks.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", description: "Optional status filter" } },
    required: [],
  },
  async execute(input) {
    const { getTaskManager } = await import("@openharness/services");
    const tasks = getTaskManager().listTasks(input.status as string | undefined);
    if (!tasks.length) return { content: [{ type: "text", text: "(no tasks)" }] };
    const text = tasks.map((t) => `${t.id} ${t.type} ${t.status} ${t.description}`).join("\n");
    return { content: [{ type: "text", text }] };
  },
};

export const taskOutputTool: ToolDefinition = {
  name: "TaskOutput",
  description: "Read the output log for a background task.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task identifier" },
      maxBytes: { type: "number", description: "Max bytes to read", default: 12000 },
    },
    required: ["taskId"],
  },
  async execute(input) {
    const { getTaskManager } = await import("@openharness/services");
    try {
      const output = getTaskManager().readTaskOutput(input.taskId as string, (input.maxBytes as number) ?? 12000);
      return { content: [{ type: "text", text: output || "(no output)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

export const taskStopTool: ToolDefinition = {
  name: "TaskStop",
  description: "Stop a background task.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string", description: "Task identifier" } },
    required: ["taskId"],
  },
  async execute(input) {
    const { getTaskManager } = await import("@openharness/services");
    try {
      const task = await getTaskManager().stopTask(input.taskId as string);
      return { content: [{ type: "text", text: `Stopped task ${task.id}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};
