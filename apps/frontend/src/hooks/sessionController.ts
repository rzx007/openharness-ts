import type {
  McpServerSnapshot,
  SelectOptionPayload,
  TranscriptItem,
  WorkflowTuiState,
} from "../types";
import type { ModelProviderInfo, TaskSnapshot } from "@openharness/client";

export type WorkflowRequestAction =
  | { type: "workflow_request"; workflow_action: "open" | "refresh" | "clear_filters" }
  | { type: "workflow_request"; workflow_action: "select_run"; workflow_run_id: string }
  | {
      type: "workflow_request";
      workflow_action: "set_filter";
      workflow_task_id?: string;
      workflow_status?: string;
    }
  | {
      type: "workflow_request";
      workflow_action: "cancel";
      workflow_run_id?: string;
      workflow_cancel_reason?: string;
    };

export type TuiAction =
  | { type: "select_model"; model: string; provider?: string }
  | { type: "submit_line"; line: string }
  | { type: "delete_session"; session_id: string }
  | { type: "interrupt" }
  | { type: "permission_response"; request_id: string; allowed: boolean; scope?: "session" | "once" }
  | { type: "question_response"; request_id: string; answer: string }
  | { type: "list_sessions" }
  | { type: "set_permission_mode"; permission_mode: "default" | "plan" | "full_auto" }
  | { type: "set_session_mode"; session_mode: "coordinator" | "direct" }
  | WorkflowRequestAction;

export type TuiSessionController = {
  transcript: TranscriptItem[];
  assistantBuffer: string;
  status: Record<string, unknown>;
  tasks: TaskSnapshot[];
  commands: string[];
  commandDetails: Array<{ name: string; description?: string }>;
  mcpServers: McpServerSnapshot[];
  modal: Record<string, unknown> | null;
  selectRequest: {
    title: string;
    submitPrefix: string;
    options: SelectOptionPayload[];
  } | null;
  displayRequest: {
    key?: string;
    title: string;
    content: string;
  } | null;
  busy: boolean;
  ready: boolean;
  workflowState: WorkflowTuiState | null;
  setModal(value: Record<string, unknown> | null): void;
  setSelectRequest(value: TuiSessionController["selectRequest"]): void;
  setDisplayRequest(value: TuiSessionController["displayRequest"]): void;
  setBusy(value: boolean): void;
  loadModels(): Promise<ModelProviderInfo[]>;
  sendRequest(action: TuiAction): void;
};
