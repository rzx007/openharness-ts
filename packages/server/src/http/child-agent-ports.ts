import type { SessionRecord, SessionRunRecord } from "@openharness/services";

export interface ChildSessionHost {
  createChildSession(input: {
    id?: string;
    parentId: string;
    cwd: string;
    model?: string;
    title: string;
    agent: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord>;
  admitPrompt(sessionId: string, content: string): Promise<{ runId?: string }>;
  awaitRun(
    sessionId: string,
    runId: string,
  ): Promise<{
    status: Extract<SessionRunRecord["status"], "completed" | "failed" | "interrupted">;
    output: string;
    error?: string;
  }>;
  interrupt(sessionId: string): Promise<void>;
  closeRuntime(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
}

export interface SessionTaskBridge {
  registerSessionTask(input: {
    description: string;
    cwd: string;
    sessionId: string;
    childSessionId: string;
    prompt: string;
    onInput(data: string): Promise<void>;
    onStop(): Promise<void>;
  }): { id: string };
  bindSessionTaskRun(taskId: string, runId: string): Promise<void>;
  completeSessionTask(
    taskId: string,
    input: { status: "completed" | "failed" | "stopped" | "interrupted"; output: string },
  ): Promise<unknown>;
  writeToSessionTask(taskId: string, data: string): Promise<void>;
}
