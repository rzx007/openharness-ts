import type { AgentDefinition } from "./index.js";

const SHARED_AGENT_PREFIX =
  "You are an agent for Claude Code, Anthropic's official CLI for Claude. " +
  "Given the user's message, you should use the tools available to complete the task. " +
  "Complete the task fully — don't gold-plate, but don't leave it half-done.";

const SHARED_AGENT_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives.
- For analysis: Start broad and narrow down.
- Be thorough: Check multiple locations, consider different naming conventions.
- NEVER create files unless absolutely necessary. ALWAYS prefer editing existing files.
- NEVER proactively create documentation files (*.md) or README files.`;

const GENERAL_PURPOSE_PROMPT = `${SHARED_AGENT_PREFIX} When you complete the task, respond with a concise report.\n\n${SHARED_AGENT_GUIDELINES}`;

const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from creating, modifying, or deleting any files.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents
- Use Read when you know the specific file path
- Use Bash ONLY for read-only operations
- Adapt your search approach based on the thoroughness level
- Communicate your final report directly — do NOT create files`;

const PLAN_PROMPT = `You are a software architect and planning specialist. Explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from creating or modifying any files.

## Your Process
1. Understand Requirements
2. Explore Thoroughly (Glob, Grep, Read)
3. Design Solution
4. Detail the Plan

End your response with:
### Critical Files for Implementation
List 3-5 files most critical for implementing this plan.`;

const WORKER_PROMPT =
  "You are an implementation-focused worker agent. Execute the assigned task precisely " +
  "and efficiently. Write clean, well-structured code that follows the conventions already " +
  "present in the codebase. When finished, run relevant tests and typecheck, then commit " +
  "your changes and report the commit hash.";

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, " +
      "and executing multi-step tasks.",
    tools: ["*"],
    systemPrompt: GENERAL_PURPOSE_PROMPT,
    subagentType: "general-purpose",
    source: "builtin",
    baseDir: "built-in",
  },
  {
    name: "Explore",
    description:
      "Fast agent specialized for exploring codebases. Use to quickly find files by patterns, " +
      "search code for keywords, or answer questions about the codebase.",
    disallowedTools: ["agent", "exit_plan_mode", "file_edit", "file_write", "notebook_edit"],
    systemPrompt: EXPLORE_PROMPT,
    model: "haiku",
    omitClaudeMd: true,
    subagentType: "Explore",
    source: "builtin",
    baseDir: "built-in",
  },
  {
    name: "Plan",
    description:
      "Software architect agent for designing implementation plans. Returns step-by-step plans, " +
      "identifies critical files, and considers architectural trade-offs.",
    disallowedTools: ["agent", "exit_plan_mode", "file_edit", "file_write", "notebook_edit"],
    systemPrompt: PLAN_PROMPT,
    omitClaudeMd: true,
    subagentType: "Plan",
    source: "builtin",
    baseDir: "built-in",
  },
  {
    name: "worker",
    description:
      "Implementation-focused worker agent. Use for concrete coding tasks: " +
      "writing features, fixing bugs, refactoring code, and running tests.",
    systemPrompt: WORKER_PROMPT,
    subagentType: "worker",
    source: "builtin",
    baseDir: "built-in",
  },
];

export function getBuiltinAgentDefinitions(): AgentDefinition[] {
  return [...BUILTIN_AGENTS];
}

export function getAgentDefinition(name: string, agents?: AgentDefinition[]): AgentDefinition | undefined {
  const all = agents ?? getAllAgentDefinitions();
  return all.find((a) => a.name === name);
}

export function getAllAgentDefinitions(): AgentDefinition[] {
  return [...BUILTIN_AGENTS];
}

export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: string[]
): boolean {
  if (!agent.requiredMcpServers?.length) return true;
  return agent.requiredMcpServers.every((pattern) =>
    availableServers.some((s) => s.toLowerCase().includes(pattern.toLowerCase()))
  );
}
