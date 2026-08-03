import type { ToolDefinition } from "@openharness/core";
import type { SwarmBackend } from "@openharness/swarm";

type AgentExecutionMode = "in_process_teammate" | "remote_agent";

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Spawn an in-process teammate task. Returns a task_id. " +
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
      mode: {
        type: "string",
        enum: ["in_process_teammate", "remote_agent"],
        description: "Agent execution mode. in_process_teammate uses the daemon child-session backend; remote_agent is reserved and currently unsupported.",
        default: "in_process_teammate",
      },
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
    const mode = parseAgentExecutionMode(input.mode);
    if (!mode) {
      return { content: [{ type: "text", text: "Invalid mode. Use in_process_teammate or remote_agent." }], isError: true };
    }
    if (mode === "remote_agent") {
      return { content: [{ type: "text", text: "remote_agent mode is not implemented yet." }], isError: true };
    }

    const permissionMode = input.permissionMode as string | undefined;
    if (permissionMode !== undefined && !["default", "plan", "full_auto"].includes(permissionMode)) {
      return { content: [{ type: "text", text: "Invalid permissionMode. Use default, plan, or full_auto." }], isError: true };
    }

    const subagentType = input.subagentType as string | undefined;
    const agentDef = subagentType ? getAgentDefinition(subagentType) : undefined;
    const agentName = subagentType ?? "agent";
    const team = (input.team as string) ?? "default";

    const executor = pickSwarmExecutor(
      context.sessionId
        ? [getBackendRegistry({ cwd: context.cwd, sessionId: context.sessionId }), getBackendRegistry()]
        : [getBackendRegistry(context.cwd), getBackendRegistry()],
      mode,
    );
    if (!executor) {
      return { content: [{ type: "text", text: `No swarm backend registered for mode ${mode}` }], isError: true };
    }

    try {
      // Pre-generate a stable session ID so the worker can persist and restore
      // its context across lazy restarts (D.1 Swarm context recovery).
      const workerSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const result = await executor.spawn({
        name: agentName,
        team,
        prompt: input.prompt as string,
        cwd: context.cwd,
        parentSessionId: context.sessionId ?? "main",
        sessionId: workerSessionId,
        model: (input.model as string) ?? agentDef?.model,
        systemPrompt: agentDef?.systemPrompt,
        permissionMode: (permissionMode ?? agentDef?.permissionMode) as "default" | "plan" | "full_auto" | undefined,
        isolate: input.isolate === true,
        allowedTools: agentDef?.tools,
        disallowedTools: agentDef?.disallowedTools,
        maxTurns: agentDef?.maxTurns,
        effort: agentDef?.effort != null ? String(agentDef.effort) : undefined,
      });
      if (!result.success) {
        return { content: [{ type: "text", text: result.error ?? "Failed to spawn agent" }], isError: true };
      }
      if (input.team) {
        try { getTeamRegistry().addAgent(input.team as string, result.taskId); } catch {}
      }
      let text = `Spawned agent ${result.agentId} (task_id=${result.taskId}, backend=${result.backendType})`;
      if (result.sessionId) text += `\nsession_id=${result.sessionId}`;
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
  description: "Send a follow-up message to a running teammate task.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Target task id or agent_id (name@team)" },
      message: { type: "string", description: "Message to send" },
    },
    required: ["taskId", "message"],
  },
  async execute(input, context) {
    const { getTaskManager } = await import("@openharness/services");
    const { getBackendRegistry } = await import("@openharness/swarm");
    const taskId = input.taskId as string;
    const message = input.message as string;

    if (taskId.includes("@")) {
      const executor = pickSwarmExecutor(
        context.sessionId
          ? [getBackendRegistry({ cwd: context.cwd, sessionId: context.sessionId }), getBackendRegistry()]
          : [getBackendRegistry(context.cwd), getBackendRegistry()],
        "in_process_teammate",
      );
      if (!executor) {
        return { content: [{ type: "text", text: "No swarm backend registered" }], isError: true };
      }
      await executor.sendMessage(taskId, { text: message, fromAgent: "coordinator" });
      return { content: [{ type: "text", text: `Sent message to agent ${taskId}` }] };
    }

    try {
      await getTaskManager({ cwd: context.cwd, sessionId: context.sessionId }).writeToTask(taskId, message);
      return { content: [{ type: "text", text: `Sent message to task ${taskId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

type BackendRegistryLike = {
  getExecutor(name?: string): SwarmBackend;
};

function pickSwarmExecutor(
  registries: BackendRegistryLike[],
  mode: AgentExecutionMode,
): SwarmBackend | undefined {
  const backendName = mode === "in_process_teammate" ? "in_process" : "remote";
  for (const registry of registries) {
    try {
      return registry.getExecutor(backendName);
    } catch {
      continue;
    }
  }
  return undefined;
}

function parseAgentExecutionMode(value: unknown): AgentExecutionMode | undefined {
  if (value === undefined) return "in_process_teammate";
  if (value === "in_process_teammate" || value === "remote_agent") return value;
  return undefined;
}
