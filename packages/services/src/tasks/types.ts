import type { Settings } from "@openharness/core";
import type { SandboxPolicy } from "@openharness/sandbox";

export type TaskType = "shell" | "agent" | "dream";
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export interface TaskInfo {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  cwd: string;
  sessionId?: string;
  command?: string;
  argv?: string[];
  prompt?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  env?: Record<string, string>;
  outputFile?: string;
  metadata: Record<string, string>;
}

export type CompletionListener = (task: TaskInfo) => void | Promise<void>;
export type TaskEvent = "created" | "updated" | "completed";
export type TaskListener = (task: TaskInfo, event: TaskEvent) => void | Promise<void>;

export interface AwaitTaskResult {
  status: TaskStatus;
  output: string;
  exitCode?: number;
  timedOut?: boolean;
}

export interface CreateShellTaskOptions {
  id?: string;
  command?: string;
  argv?: string[];
  description: string;
  cwd: string;
  sessionId?: string;
  type?: TaskType;
  env?: Record<string, string>;
  settings?: Settings;
  policy?: SandboxPolicy;
}

export interface CreateAgentTaskOptions {
  id?: string;
  prompt: string;
  description: string;
  cwd: string;
  sessionId?: string;
  type?: TaskType;
  model?: string;
  command?: string;
  argv?: string[];
  env?: Record<string, string>;
  settings?: Settings;
  policy?: SandboxPolicy;
}

export interface RegisterSessionTaskOptions {
  id?: string;
  description: string;
  cwd: string;
  sessionId: string;
  childSessionId: string;
  prompt: string;
  onInput(data: string): Promise<void>;
  onStop(): Promise<void>;
}

export interface CompleteSessionTaskInput {
  status: Extract<TaskStatus, "completed" | "failed" | "stopped">;
  output: string;
}

export interface TaskManagerScope {
  cwd: string;
  sessionId?: string;
}
