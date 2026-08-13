import type { ToolDefinition } from "@openharness/core";

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Spawn an in-process teammate task. Returns a framework-owned live task_id. " +
    "Use TaskWait with that task_id to block until the task finishes and retrieve its result; " +
    "use SendMessage for follow-up input while the live child invocation is still active.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short description of the delegated work" },
      prompt: { type: "string", description: "Full prompt for the agent" },
      subagentType: { type: "string", description: "Agent type (e.g. general-purpose, Explore, worker)" },
      model: { type: "string", description: "Model override" },
      team: { type: "string", description: "Optional team to attach the agent to" },
      permissionMode: {
        type: "string",
        enum: ["default", "plan", "full_auto"],
        description:
          "Permission mode for the spawned agent. Defaults to 'default': write operations are " +
          "escalated to the leader through the framework permission effect.",
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
    const { getAgentDefinition, getTeamRegistry } = await import("@openharness/coordinator");

    if (input.mode !== undefined) {
      return {
        content: [{ type: "text", text: "Agent.mode is not supported. Agent always uses the framework child manager." }],
        isError: true,
      };
    }

    const permissionMode = input.permissionMode as string | undefined;
    if (permissionMode !== undefined && !["default", "plan", "full_auto"].includes(permissionMode)) {
      return { content: [{ type: "text", text: "Invalid permissionMode. Use default, plan, or full_auto." }], isError: true };
    }

    const children = context.agent?.children;
    if (!children) {
      return { content: [{ type: "text", text: "No framework child manager registered for Agent tool" }], isError: true };
    }

    const subagentType = input.subagentType as string | undefined;
    const agentDef = subagentType ? getAgentDefinition(subagentType) : undefined;
    const agentName = subagentType ?? "agent";
    const team = (input.team as string) ?? "default";
    const agentId = `${agentName}@${team}`;

    try {
      const workerSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const invocation = await children.spawnChildAgent({
        description: input.description as string,
        prompt: input.prompt as string,
        agent: agentName,
        team,
        cwd: context.cwd,
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

      const taskId = invocation.id;

      if (input.team) {
        try {
          getTeamRegistry().addAgent(input.team as string, taskId);
        } catch {
          // Team registration is best-effort; spawning already succeeded.
        }
      }

      let text = `Spawned agent ${agentId} (task_id=${taskId}, backend=framework)`;
      text += `\nsession_id=${invocation.sessionId}`;
      if (invocation.worktree) {
        text += `\nIsolated: changes land on branch \`${invocation.worktree.branch}\`, worktree path \`${invocation.worktree.path}\` - review/merge it yourself.`;
        text += `\nWhen done reviewing, clean it up with \`git worktree remove ${invocation.worktree.path}\` (or \`git worktree remove --force ${invocation.worktree.path}\` to discard uncommitted changes).`;
      }
      if (invocation.notice) {
        text += `\nNotice: ${invocation.notice}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

export const sendMessageTool: ToolDefinition = {
  name: "SendMessage",
  description:
    "Send a follow-up message to a running teammate task. For Agent-created child sessions, " +
    "the task_id is resolved to the run-local child invocation handle before falling back to ordinary TaskManager input.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Target task id returned by Agent" },
      message: { type: "string", description: "Message to send" },
    },
    required: ["taskId", "message"],
  },
  async execute(input, context) {
    const taskId = input.taskId as string;
    const message = input.message as string;

    if (taskId.includes("@")) {
      const children = context.agent?.children;
      if (!children) {
        return { content: [{ type: "text", text: `No active child invocation for agent ${taskId}` }], isError: true };
      }
      try {
        await children.sendChildInput(taskId, { content: message });
        return { content: [{ type: "text", text: `Sent message to agent ${taskId}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    }

    try {
      const children = context.agent?.children;
      if (children?.hasChildAgent(taskId)) {
        await children.sendChildInput(taskId, { content: message });
        return { content: [{ type: "text", text: `Sent message to task ${taskId}` }] };
      }
      const { getTaskManager } = await import("@openharness/services");
      await getTaskManager({ cwd: context.cwd, sessionId: context.sessionId }).writeToTask(taskId, message);
      return { content: [{ type: "text", text: `Sent message to task ${taskId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  },
};

