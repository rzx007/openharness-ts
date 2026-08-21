const PYTHON_STYLE_TOOL_NAME_ALIASES: Record<string, string> = {
  agent: "Agent",
  job_list: "JobList",
  job_read: "JobRead",
  job_wait: "JobWait",
  job_send: "JobSend",
  job_cancel: "JobCancel",
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
  background_shell_create: "BackgroundShellCreate",
  schedule_create: "ScheduleCreate",
  schedule_update: "ScheduleUpdate",
  schedule_delete: "ScheduleDelete",
  schedule_list: "ScheduleList",
  schedule_run_now: "ScheduleRunNow",
  mcp_tool_call: "McpToolCall",
  list_mcp_resources: "ListMcpResources",
  read_mcp_resource: "ReadMcpResource",
  mcp_auth: "McpAuth",
  lsp: "Lsp",
  image_to_text: "ImageToText",
  image_generation: "ImageGeneration",
  feishu_push: "FeishuPush",
};

const REMOVED_LIFECYCLE_TOOL_REPLACEMENTS: Record<string, string | undefined> =
  {
    taskget: "JobRead",
    task_get: "JobRead",
    tasklist: "JobList",
    task_list: "JobList",
    taskoutput: "JobRead",
    task_output: "JobRead",
    taskstop: "JobCancel",
    task_stop: "JobCancel",
    taskwait: "JobWait",
    task_wait: "JobWait",
    taskupdate: undefined,
    task_update: undefined,
    sendmessage: "JobSend",
    send_message: "JobSend",
    terminalread: "JobRead",
    terminal_read: "JobRead",
    terminallist: "JobList",
    terminal_list: "JobList",
    terminalsend: "JobSend",
    terminal_send: "JobSend",
    terminalsignal: "JobCancel",
    terminal_signal: "JobCancel",
    terminalclose: "JobCancel",
    terminal_close: "JobCancel",
  };

/** Reject only lifecycle names removed by the Jobs hard cut; unknown plugin tools remain valid. */
export function assertNoRemovedLifecycleToolNames(
  tools: readonly string[],
  source: string,
): void {
  const removed = new Map<string, string | undefined>();
  for (const tool of tools) {
    const trimmed = tool.trim();
    const key = trimmed.toLowerCase();
    if (
      Object.prototype.hasOwnProperty.call(
        REMOVED_LIFECYCLE_TOOL_REPLACEMENTS,
        key,
      )
    ) {
      removed.set(trimmed, REMOVED_LIFECYCLE_TOOL_REPLACEMENTS[key]);
    }
  }
  if (removed.size === 0) return;

  const migrations = [...removed].map(([tool, replacement]) =>
    replacement
      ? `"${tool}" -> "${replacement}"`
      : `"${tool}" (remove it; no Job equivalent)`,
  );
  throw new Error(
    `${source} contains removed lifecycle tool names: ${migrations.join(", ")}. ` +
      "Compatibility aliases are not supported.",
  );
}

export function normalizeToolName(
  tool: string,
  knownToolNames: readonly string[] = [],
): string | undefined {
  const trimmed = tool.trim();
  if (!trimmed) return undefined;
  if (trimmed === "*") return "*";

  const known = knownToolNames.find(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
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
