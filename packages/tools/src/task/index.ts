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

export const taskWaitTool: ToolDefinition = {
  name: "TaskWait",
  description:
    "Block until one or more background tasks finish and return their results. " +
    "Use this to wait for sub-tasks spawned by the Agent tool (it returns a task_id): " +
    "after spawning, call TaskWait with those task_id(s) instead of polling with Sleep. " +
    "Accepts taskIds (string[] — also tolerates a single string) and an optional " +
    "timeoutSeconds (default 300). Each task is awaited independently, so one failed, " +
    "timed-out, or unknown task_id does not affect the others; the result is a readable " +
    "per-task summary with each task's final status and output.",
  inputSchema: {
    type: "object",
    properties: {
      taskIds: {
        type: "array",
        items: { type: "string" },
        description: "Task identifiers to wait for (a single string is also accepted)",
      },
      timeoutSeconds: {
        type: "number",
        description: "Per-task wait timeout in seconds before giving up",
        default: 300,
      },
    },
    required: ["taskIds"],
  },
  async execute(input) {
    const { getTaskManager } = await import("@openharness/services");
    const mgr = getTaskManager();

    // Normalize taskIds: accept a single string or an array of strings.
    const raw = input.taskIds;
    let taskIds: string[];
    if (typeof raw === "string") {
      taskIds = [raw];
    } else if (Array.isArray(raw)) {
      taskIds = raw.filter((t): t is string => typeof t === "string");
    } else {
      taskIds = [];
    }
    if (taskIds.length === 0) {
      return { content: [{ type: "text", text: "taskIds is required (string or string[])" }], isError: true };
    }

    const timeoutSeconds = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : 300;
    const timeoutMs = timeoutSeconds * 1000;

    // Await every task independently so a single failed/unknown id never drags
    // down the rest. awaitTask throws synchronously on an unknown id, so wrap
    // each call in its own try/catch via an async closure.
    const segments = await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          const res = await mgr.awaitTask(taskId, { timeoutMs });
          if (res.timedOut) {
            return (
              `${taskId} (${res.status}): did not finish within ${timeoutSeconds}s — ` +
              `you can keep waiting with TaskWait or stop it with TaskStop.\n` +
              `Output so far:\n${res.output}`
            );
          }
          const exit = res.exitCode != null ? ` exit=${res.exitCode}` : "";
          return `${taskId} (${res.status}${exit}):\n${res.output}`;
        } catch (err) {
          return `${taskId} (error): ${(err as Error).message}`;
        }
      }),
    );

    const anyError = segments.some((s) => s.includes("(error):"));
    return {
      content: [{ type: "text", text: segments.join("\n\n") }],
      ...(anyError ? { isError: true } : {}),
    };
  },
};

export const taskUpdateTool: ToolDefinition = {
  name: "TaskUpdate",
  description: "Update a task description, progress, or status note.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task identifier" },
      description: { type: "string", description: "Updated task description" },
      progress: {
        type: "number",
        description: "Progress percentage (0-100)",
      },
      statusNote: {
        type: "string",
        description: "Short human-readable task note",
      },
    },
    required: ["taskId"],
  },
  async execute(input) {
    const { getTaskManager } = await import("@openharness/services");
    const mgr = getTaskManager();
    const task = mgr.getTask(input.taskId as string);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
        isError: true,
      };
    }
    const parts = [`Updated task ${task.id}`];
    if (input.description) {
      (task as any).description = input.description;
      parts.push(`description=${input.description}`);
    }
    if (input.progress !== undefined) {
      parts.push(`progress=${input.progress}%`);
    }
    if (input.statusNote) {
      parts.push(`note=${input.statusNote}`);
    }
    return { content: [{ type: "text", text: parts.join(" ") }] };
  },
};
