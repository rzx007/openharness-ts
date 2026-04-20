export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string | number;
  permissionMode?: string;
  maxTurns?: number;
  skills?: string[];
  mcpServers?: unknown[];
  hooks?: Record<string, unknown>;
  color?: string;
  background?: boolean;
  initialPrompt?: string;
  memory?: string;
  isolation?: string;
  omitClaudeMd?: boolean;
  criticalSystemReminder?: string;
  requiredMcpServers?: string[];
  filename?: string;
  baseDir?: string;
  source?: "builtin" | "user" | "plugin";
  subagentType?: string;
}

export type CoordinatorMode = "sequential" | "parallel" | "pipeline";

export interface CoordinatorConfig {
  mode: CoordinatorMode;
  agents: AgentDefinition[];
}

export interface TaskNotification {
  taskId: string;
  status: "completed" | "failed" | "killed";
  summary: string;
  result?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
}

export const COORDINATOR_SYSTEM_PROMPT = `You are an AI assistant that orchestrates software engineering tasks across multiple workers.

## 1. Your Role

You are a **coordinator**. Your job is to:
- Help the user achieve their goal
- Direct workers to research, implement and verify code changes
- Synthesize results and communicate with the user
- Answer questions directly when possible — don't delegate work that you can handle without tools

Every message you send is to the user. Worker results and system notifications are internal signals, not conversation partners — never thank or acknowledge them. Summarize new information for the user as it arrives.

## 2. Your Tools

- **agent** - Spawn a new worker
- **send_message** - Continue an existing worker (send a follow-up to its \`to\` agent ID)
- **task_stop** - Stop a running worker

When calling agent:
- Do not use one worker to check on another. Workers will notify you when they are done.
- Do not use workers to trivially report file contents or run commands. Give them higher-level tasks.
- Continue workers whose work is complete via send_message to take advantage of their loaded context
- After launching agents, briefly tell the user what you launched and end your response.

## 3. Workers

When calling agent, use subagent_type \`worker\`. Workers execute tasks autonomously — especially research, implementation, or verification.

Workers have access to standard tools, MCP tools from configured MCP servers, and project skills via the Skill tool. Delegate skill invocations to workers.

## 4. Task Workflow

| Phase | Who | Purpose |
|-------|-----|---------|
| Research | Workers (parallel) | Investigate codebase, find files, understand problem |
| Synthesis | **You** (coordinator) | Read findings, understand the problem, craft implementation specs |
| Implementation | Workers | Make targeted changes per spec, commit |
| Verification | Workers | Test changes work |

### Concurrency

**Parallelism is your superpower. Workers are async. Launch independent workers concurrently whenever possible — don't serialize work that can run simultaneously.**

Manage concurrency:
- **Read-only tasks** (research) — run in parallel freely
- **Write-heavy tasks** (implementation) — one at a time per set of files
- **Verification** can sometimes run alongside implementation on different file areas

## 5. Writing Worker Prompts

**Workers can't see your conversation.** Every prompt must be self-contained with everything the worker needs.

### Always synthesize — your most important job

When workers report research findings, **you must understand them before directing follow-up work**. Read the findings. Identify the approach. Then write a prompt that proves you understood by including specific file paths, line numbers, and exactly what to change.

Never write "based on your findings" or "based on the research." These phrases delegate understanding to the worker instead of doing it yourself.

Good prompt example:
"Fix the null pointer in src/auth/validate.ts:42. The user field is undefined when Session.expired is true. Add a null check before accessing user.id — if null, return 401. Commit and report the hash."

### Continue vs. spawn

| Situation | Mechanism |
|-----------|-----------|
| Research explored exactly the files that need editing | **Continue** (send_message) |
| Research was broad but implementation is narrow | **Spawn fresh** (agent) |
| Correcting a failure or extending recent work | **Continue** |
| Verifying code a different worker just wrote | **Spawn fresh** |
| Completely unrelated task | **Spawn fresh** |`;

export class Coordinator {
  private config: CoordinatorConfig;

  constructor(config: CoordinatorConfig) {
    this.config = config;
  }

  getAgents(): AgentDefinition[] {
    return this.config.agents;
  }

  getMode(): CoordinatorMode {
    return this.config.mode;
  }
}

export interface TeamRecord {
  name: string;
  description: string;
  agents: string[];
  messages: string[];
}

export class TeamRegistry {
  private teams = new Map<string, TeamRecord>();

  createTeam(name: string, description = ""): TeamRecord {
    if (this.teams.has(name)) {
      throw new Error(`Team '${name}' already exists`);
    }
    const team: TeamRecord = { name, description, agents: [], messages: [] };
    this.teams.set(name, team);
    return team;
  }

  deleteTeam(name: string): void {
    if (!this.teams.has(name)) {
      throw new Error(`Team '${name}' does not exist`);
    }
    this.teams.delete(name);
  }

  addAgent(teamName: string, taskId: string): void {
    const team = this.requireTeam(teamName);
    if (!team.agents.includes(taskId)) {
      team.agents.push(taskId);
    }
  }

  sendMessage(teamName: string, message: string): void {
    this.requireTeam(teamName).messages.push(message);
  }

  listTeams(): TeamRecord[] {
    return [...this.teams.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private requireTeam(name: string): TeamRecord {
    const team = this.teams.get(name);
    if (!team) throw new Error(`Team '${name}' does not exist`);
    return team;
  }
}

let _defaultTeamRegistry: TeamRegistry | undefined;

export function getTeamRegistry(): TeamRegistry {
  if (!_defaultTeamRegistry) {
    _defaultTeamRegistry = new TeamRegistry();
  }
  return _defaultTeamRegistry;
}

export function isCoordinatorMode(): boolean {
  return (
    process.env.COORDINATOR_MODE === "1" ||
    process.env.OPENHARNESS_COORDINATOR === "1" ||
    process.env.CLAUDE_CODE_COORDINATOR === "1"
  );
}

export function formatTaskNotification(notification: TaskNotification): string {
  const lines = [
    "<task-notification>",
    `<task-id>${notification.taskId}</task-id>`,
    `<status>${notification.status}</status>`,
    `<summary>${notification.summary}</summary>`,
  ];
  if (notification.result) {
    lines.push(`<result>${notification.result}</result>`);
  }
  if (notification.usage) {
    lines.push(
      "<usage>",
      `  <total_tokens>${notification.usage.totalTokens}</total_tokens>`,
      `  <tool_uses>${notification.usage.toolUses}</tool_uses>`,
      `  <duration_ms>${notification.usage.durationMs}</duration_ms>`,
      "</usage>",
    );
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}

export function parseTaskNotification(text: string): TaskNotification | undefined {
  const match = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!match) return undefined;

  const body = match[1]!;

  const taskId = body.match(/<task-id>(.*?)<\/task-id>/)?.[1];
  const status = body.match(/<status>(.*?)<\/status>/)?.[1] as TaskNotification["status"];
  const summary = body.match(/<summary>(.*?)<\/summary>/)?.[1];
  const result = body.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim();

  if (!taskId || !status || !summary) return undefined;

  const usageBlock = body.match(/<usage>([\s\S]*?)<\/usage>/)?.[1];
  let usage: TaskNotification["usage"];
  if (usageBlock) {
    usage = {
      totalTokens: parseInt(usageBlock.match(/<total_tokens>(\d+)/)?.[1] ?? "0", 10),
      toolUses: parseInt(usageBlock.match(/<tool_uses>(\d+)/)?.[1] ?? "0", 10),
      durationMs: parseInt(usageBlock.match(/<duration_ms>(\d+)/)?.[1] ?? "0", 10),
    };
  }

  return { taskId, status, summary, result, usage };
}

export {
  getBuiltinAgentDefinitions,
  getAgentDefinition,
  getAllAgentDefinitions,
  hasRequiredMcpServers,
} from "./agent-definitions";
