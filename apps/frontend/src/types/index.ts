export type FrontendConfig = {
  backend_command: string[];
  initial_prompt?: string | null;
  theme?: string | null;
  version?: string | null;
};

export type TranscriptItem = {
  role: "system" | "user" | "assistant" | "tool" | "tool_result" | "log";
  text: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
};

export type TaskSnapshot = {
  id: string;
  type: string;
  status: string;
  description: string;
  metadata: Record<string, string>;
};

export type McpServerSnapshot = {
  name: string;
  state: string;
  detail?: string;
  transport?: string;
  auth_configured?: boolean;
  tool_count?: number;
  resource_count?: number;
};

export type BridgeSessionSnapshot = {
  session_id: string;
  command: string;
  cwd: string;
  pid: number;
  status: string;
  started_at: number;
  output_path: string;
};

export type SelectOptionPayload = {
  value: string;
  label: string;
  description?: string;
};

export type TodoItemSnapshot = {
  text: string;
  checked: boolean;
};

export type SwarmTeammateSnapshot = {
  name: string;
  status: "running" | "idle" | "done" | "error";
  duration?: number;
  task?: string;
};

export type SwarmNotificationSnapshot = {
  from: string;
  message: string;
  timestamp: number;
};

export type BackendEvent =
  | {
      type: "ready";
      state?: Record<string, unknown> | null;
      tasks?: TaskSnapshot[] | null;
      commands?: string[] | null;
      /** 斜杠命令明细（名称 + 描述），旧后端可能缺省 */
      command_details?: Array<{ name: string; description?: string }> | null;
      mcp_servers?: McpServerSnapshot[] | null;
      bridge_sessions?: BridgeSessionSnapshot[] | null;
    }
  | {
      type: "state_snapshot";
      state?: Record<string, unknown> | null;
      mcp_servers?: McpServerSnapshot[] | null;
      bridge_sessions?: BridgeSessionSnapshot[] | null;
    }
  | { type: "tasks_snapshot"; tasks?: TaskSnapshot[] | null }
  | { type: "transcript_item"; item: TranscriptItem }
  | { type: "assistant_delta"; message: string }
  | { type: "assistant_complete"; message?: string | null }
  | { type: "line_complete" }
  | {
      type: "tool_started";
      item: TranscriptItem;
      tool_name?: string | null;
      is_error?: boolean | null;
    }
  | {
      type: "tool_completed";
      item: TranscriptItem;
      tool_name?: string | null;
      is_error?: boolean | null;
    }
  | { type: "clear_transcript" }
  | {
      type: "select_request";
      modal?: Record<string, unknown> | null;
      select_options?: SelectOptionPayload[] | null;
    }
  | { type: "modal_request"; modal?: Record<string, unknown> | null }
  | { type: "error"; message?: string | null }
  | { type: "todo_update"; todo_markdown?: string | null }
  | {
      type: "swarm_status";
      swarm_teammates?: SwarmTeammateSnapshot[] | null;
      swarm_notifications?: SwarmNotificationSnapshot[] | null;
    }
  | { type: "plan_mode_change"; plan_mode?: string | null }
  | { type: "shutdown" };

export type FrontendRequest = {
  type: "submit_line" | "permission_response" | "question_response" | "list_sessions" | "delete_session" | "shutdown" | "interrupt";
  line?: string | null;
  request_id?: string | null;
  allowed?: boolean | null;
  /** 权限批准范围："once"（本次）| "session"（整个会话该工具放行）。 */
  scope?: "once" | "session" | null;
  answer?: string | null;
  /** delete_session 时携带的会话 ID。 */
  session_id?: string | null;
};
