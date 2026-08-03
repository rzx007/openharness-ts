export type FrontendConfig = {
  daemon?: {
    url: string;
    token?: string | null;
    cwd?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    maxTurns?: number | null;
  } | null;
  initial_prompt?: string | null;
  theme?: string | null;
  version?: string | null;
};

export type TranscriptItem = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool" | "tool_result" | "log";
  text: string;
  streaming?: boolean;
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

export type WorkflowRunSummarySnapshot = {
  runId: string;
  status: "running" | "completed" | "failed" | string;
  summary: string;
  mode: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  runningTasks: number;
  blockedTasks: number;
  needsReconciliation: boolean;
  budgetPolicyPreset?: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowTuiTaskSnapshot = {
  taskId: string;
  status: string;
  summary?: string;
  dependencies: string[];
  taskManagerTaskId?: string;
};

export type WorkflowTuiTimelineItem = {
  timestamp: number;
  type: string;
  taskId?: string;
  status?: string;
  summary: string;
};

export type WorkflowTuiState = {
  runs: WorkflowRunSummarySnapshot[];
  selectedRunId?: string;
  snapshot?: Record<string, unknown>;
  tasks: WorkflowTuiTaskSnapshot[];
  timeline: WorkflowTuiTimelineItem[];
  filters: {
    taskId?: string;
    eventType?: string;
    status?: string;
  };
  available: {
    taskIds: string[];
    eventTypes: string[];
    statuses: string[];
  };
  reconciliation?: {
    needed: boolean;
    summary: string;
    actions: Array<{
      actionId: string;
      issueIds: string[];
      taskId: string;
      description: string;
      prompt: string;
      writeScope: string[];
      dependsOn: string[];
    }>;
  };
  selectedReconciliationActionId?: string;
  reconciliationSpec?: unknown;
  notice?: string;
  error?: string;
};
