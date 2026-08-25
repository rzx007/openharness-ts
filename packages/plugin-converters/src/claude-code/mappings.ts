export const CLAUDE_MAPPING_VERSION = "1";
export const CLAUDE_HOOK_EVENT_MAP: Record<string, string | undefined> = {
  SessionStart: "session_start", PreToolUse: "pre_tool_use", PostToolUse: "post_tool_use", SessionEnd: "session_end",
};
