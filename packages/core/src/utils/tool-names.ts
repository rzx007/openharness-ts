const PYTHON_STYLE_TOOL_NAME_ALIASES: Record<string, string> = {
  agent: "Agent",
  send_message: "SendMessage",
  task_stop: "TaskStop",
  task_wait: "TaskWait",
  workflow: "Workflow",
  team_create: "TeamCreate",
  team_delete: "TeamDelete",
  bash: "Bash",
  read: "Read",
  read_file: "Read",
  file_read: "Read",
  edit: "Edit",
  file_edit: "Edit",
  write: "Write",
  file_write: "Write",
  glob: "Glob",
  grep: "Grep",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  todo_write: "TodoWrite",
  tool_search: "ToolSearch",
  ask_user: "AskUser",
  notebook_edit: "NotebookEdit",
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
  enter_worktree: "EnterWorktree",
  exit_worktree: "ExitWorktree",
  skill: "Skill",
  sleep: "Sleep",
  config: "Config",
  brief: "Brief",
  task_create: "TaskCreate",
  task_get: "TaskGet",
  task_list: "TaskList",
  task_output: "TaskOutput",
  task_update: "TaskUpdate",
  cron_create: "CronCreate",
  cron_delete: "CronDelete",
  cron_list: "CronList",
  cron_toggle: "CronToggle",
  remote_trigger: "RemoteTrigger",
  mcp_tool_call: "McpToolCall",
  list_mcp_resources: "ListMcpResources",
  read_mcp_resource: "ReadMcpResource",
  mcp_auth: "McpAuth",
  lsp: "Lsp",
  image_to_text: "ImageToText",
  image_generation: "ImageGeneration",
  feishu_push: "FeishuPush",
};

export function normalizeToolName(
  tool: string,
  knownToolNames: readonly string[] = [],
): string | undefined {
  const trimmed = tool.trim();
  if (!trimmed) return undefined;
  if (trimmed === "*") return "*";

  const known = knownToolNames.find((name) => name.toLowerCase() === trimmed.toLowerCase());
  if (known) return known;

  return PYTHON_STYLE_TOOL_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeToolNames(
  tools: readonly string[],
  knownToolNames: readonly string[] = [],
): string[] {
  const normalized = tools
    .map((tool) => normalizeToolName(tool, knownToolNames))
    .filter((tool): tool is string => tool !== undefined);
  return [...new Set(normalized)];
}

export function resolveAllowedToolNames(
  tools: readonly string[],
  knownToolNames: readonly string[] = [],
): string[] {
  const normalized = normalizeToolNames(tools, knownToolNames);
  return normalized.includes("*") ? [] : normalized;
}
