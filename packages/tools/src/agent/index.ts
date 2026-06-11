import type { ToolDefinition } from "@openharness/core";

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Spawn a local background agent task. Returns a task_id. " +
    "Use TaskWait with that task_id to block until the task finishes and retrieve its result — " +
    "do not poll with Sleep.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short description of the delegated work" },
      prompt: { type: "string", description: "Full prompt for the agent" },
      subagentType: { type: "string", description: "Agent type (e.g. general-purpose, Explore, worker)" },
      model: { type: "string", description: "Model override" },
      team: { type: "string", description: "Optional team to attach the agent to" },
      mode: { type: "string", description: "Agent mode", default: "local_agent" },
      permissionMode: {
        type: "string",
        enum: ["default", "plan", "full_auto"],
        description:
          "Permission mode for the spawned agent. Defaults to 'default': write operations are " +
          "escalated to the leader for approval via the swarm permission file flow.",
      },
      isolate: {
        type: "boolean",
        description:
          "For parallel write tasks, isolate the sub-agent into its own git worktree (separate branch) " +
          "so concurrent file edits don't conflict. Not needed for read-only exploration.",
      },
    },
    required: ["description", "prompt"],
  },
  async execute(input, context) {
    const { getBackendRegistry } = await import("@openharness/swarm");
    const { getAgentDefinition } = await import("@openharness/coordinator");
    const { getTeamRegistry } = await import("@openharness/coordinator");
    const mode = (input.mode as string) ?? "local_agent";
    if (!["local_agent", "remote_agent", "in_process_teammate"].includes(mode)) {
      return { content: [{ type: "text", text: "Invalid mode. Use local_agent, remote_agent, or in_process_teammate." }], isError: true };
    }

    const permissionMode = input.permissionMode as string | undefined;
    if (permissionMode !== undefined && !["default", "plan", "full_auto"].includes(permissionMode)) {
      return { content: [{ type: "text", text: "Invalid permissionMode. Use default, plan, or full_auto." }], isError: true };
    }

    const subagentType = input.subagentType as string | undefined;
    const agentDef = subagentType ? getAgentDefinition(subagentType) : undefined;
    const agentName = subagentType ?? "agent";
    const team = (input.team as string) ?? "default";

    const registry = getBackendRegistry();
    let executor;
    try { executor = registry.getExecutor("in_process"); } catch {
      try { executor = registry.getExecutor("subprocess"); } catch {
        try { executor = registry.getExecutor(); } catch {
          return { content: [{ type: "text", text: "No swarm backend registered" }], isError: true };
        }
      }
    }

    try {
      const result = await executor.spawn({
        name: agentName,
        team,
        prompt: input.prompt as string,
        cwd: context.cwd,
        parentSessionId: "main",
        model: (input.model as string) ?? agentDef?.model,
        systemPrompt: agentDef?.systemPrompt,
        permissionMode: permissionMode as "default" | "plan" | "full_auto" | undefined,
        isolate: input.isolate === true,
      });
      if (!result.success) {
        return { content: [{ type: "text", text: result.error ?? "Failed to spawn agent" }], isError: true };
      }
      if (input.team) {
        try { getTeamRegistry().addAgent(input.team as string, result.taskId); } catch {}
      }
      let text = `Spawned agent ${result.agentId} (task_id=${result.taskId}, backend=${result.backendType})`;
      if (result.worktree) {
        text += `\nIsolated: changes land on branch \`${result.worktree.branch}\`, worktree path \`${result.worktree.path}\` — review/merge it yourself.`;
        text += `\nWhen done reviewing, clean it up with \`git worktree remove ${result.worktree.path}\` (or \`git worktree remove --force ${result.worktree.path}\` to discard uncommitted changes).`;
      }
      if (result.notice) {
        text += `\nNotice: ${result.notice}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

export const sendMessageTool: ToolDefinition = {
  name: "SendMessage",
  description: "Send a follow-up message to a running local agent task.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Target task id or agent_id (name@team)" },
      message: { type: "string", description: "Message to send" },
    },
    required: ["taskId", "message"],
  },
  async execute(input) {
    const { getTaskManager } = await import("@openharness/services");
    const { getBackendRegistry } = await import("@openharness/swarm");
    const taskId = input.taskId as string;
    const message = input.message as string;

    if (taskId.includes("@")) {
      const registry = getBackendRegistry();
      try {
        const executor = registry.getExecutor("in_process");
        await executor.sendMessage(taskId, { text: message, fromAgent: "coordinator" });
      } catch {
        try {
          const executor = registry.getExecutor("subprocess");
          await executor.sendMessage(taskId, { text: message, fromAgent: "coordinator" });
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
      }
      return { content: [{ type: "text", text: `Sent message to agent ${taskId}` }] };
    }

    try {
      await getTaskManager().writeToTask(taskId, message);
      return { content: [{ type: "text", text: `Sent message to task ${taskId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};
