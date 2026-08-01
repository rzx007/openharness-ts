import type {
  BridgeSessionSnapshot,
  McpServerSnapshot,
  SelectOptionPayload,
  SwarmNotificationSnapshot,
  SwarmTeammateSnapshot,
  TaskSnapshot,
  TranscriptItem,
  WorkflowTuiState,
} from "../types";

export type TuiSessionController = {
  transcript: TranscriptItem[];
  assistantBuffer: string;
  status: Record<string, unknown>;
  tasks: TaskSnapshot[];
  commands: string[];
  commandDetails: Array<{ name: string; description?: string }>;
  mcpServers: McpServerSnapshot[];
  bridgeSessions: BridgeSessionSnapshot[];
  modal: Record<string, unknown> | null;
  selectRequest: {
    title: string;
    submitPrefix: string;
    options: SelectOptionPayload[];
  } | null;
  busy: boolean;
  ready: boolean;
  todoMarkdown: string;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  workflowState: WorkflowTuiState | null;
  setModal(value: Record<string, unknown> | null): void;
  setSelectRequest(value: TuiSessionController["selectRequest"]): void;
  setBusy(value: boolean): void;
  sendRequest(payload: Record<string, unknown>): void;
};
