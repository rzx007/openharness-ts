import type { JobStatus } from "@openharness/jobs";
import type { TerminalEventListener } from "./events";

export type TerminalRuntime = "local" | "sandbox";
export type TerminalSessionStatus = JobStatus;
export type TerminalSource = "user" | "agent";
export type TerminalSignal = "interrupt" | "eof" | "terminate";

export interface TerminalCreateRequest {
  projectId: string;
  runtime: TerminalRuntime;
  cols: number;
  rows: number;
  name?: string;
  shell?: string;
  cwd?: string;
  source?: TerminalSource;
  sessionId?: string;
}

export interface TerminalSessionInfo {
  id: string;
  name: string;
  projectId: string;
  runtime: TerminalRuntime;
  source: TerminalSource;
  sessionId?: string;
  status: TerminalSessionStatus;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number | null;
}

export interface TerminalWriteRequest {
  terminalId: string;
  data: string;
}

export interface TerminalResizeRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalReadRequest {
  terminalId: string;
  after?: number;
  maxChars?: number;
}

export interface TerminalReadResult {
  terminalId: string;
  data: string;
  sequence: number;
  truncated: boolean;
}

export interface TerminalSignalRequest {
  terminalId: string;
  signal: TerminalSignal;
}

export interface TerminalWaitRequest extends TerminalReadRequest {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TerminalWaitResult extends TerminalReadResult {
  terminal: TerminalSessionInfo;
  timedOut: boolean;
}

export interface AgentTerminalOpenRequest {
  sessionId: string;
  cwd: string;
  name?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

/** Host-owned Terminal producer. Observation and control use AgentJobHost. */
export interface AgentTerminalHost {
  open(input: AgentTerminalOpenRequest): Promise<TerminalSessionInfo>;
}

export interface TerminalProvider {
  create(input: TerminalCreateRequest): Promise<TerminalSessionInfo>;
  write(input: TerminalWriteRequest): Promise<void>;
  resize(input: TerminalResizeRequest): Promise<void>;
  read(input: TerminalReadRequest): Promise<TerminalReadResult>;
  wait(input: TerminalWaitRequest): Promise<TerminalWaitResult>;
  signal(input: TerminalSignalRequest): Promise<void>;
  kill(terminalId: string): Promise<void>;
  list(): Promise<TerminalSessionInfo[]>;
  subscribe(listener: TerminalEventListener): () => void;
}

export type TerminalConnection = TerminalProvider;
