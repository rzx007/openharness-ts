export type JobKind = "terminal" | "shell" | "agent" | "dream" | "workflow";

export type JobStatus =
  | "running"
  | "stopping"
  | "completed"
  | "killed"
  | "failed";

export interface JobCapabilities {
  read: boolean;
  wait: boolean;
  send: boolean;
  cancel: boolean;
}

/** Fresh, read-only view. Access is authorized by ownerSession, never by id secrecy. */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  label: string;
  ownerSession: string;
  status: JobStatus;
  capabilities: JobCapabilities;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface JobReadRequest {
  sessionId: string;
  jobId: string;
  after?: number;
  maxChars?: number;
}

export interface JobReadResult {
  text: string;
  cursor: number;
  truncated: boolean;
  snapshot: JobSnapshot;
}

export interface JobWaitRequest extends JobReadRequest {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface JobWaitResult extends JobReadResult {
  timedOut: boolean;
}

export interface JobSendRequest {
  sessionId: string;
  jobId: string;
  data: string;
}

export interface JobCancelRequest {
  sessionId: string;
  jobId: string;
  reason?: string;
}

export interface JobListRequest {
  sessionId: string;
  status?: JobStatus;
}

/** Host-owned job controller exposed to an Agent. */
export interface AgentJobHost {
  list(input: JobListRequest): Promise<JobSnapshot[]>;
  read(input: JobReadRequest): Promise<JobReadResult>;
  wait(input: JobWaitRequest): Promise<JobWaitResult>;
  send(input: JobSendRequest): Promise<void>;
  cancel(input: JobCancelRequest): Promise<JobSnapshot>;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "killed" || status === "failed";
}
