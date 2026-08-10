import { randomUUID } from "node:crypto";

import type {
  AgentChildAgentHost,
  AgentChildAgentInput,
  AgentChildAgentInvocation,
  AgentChildAgentResult,
  AgentChildAgentSpawnInput,
  AgentRunHost,
  AgentRunScope,
  Settings,
} from "@openharness/core";

import type { OpenHarnessAgent, OpenHarnessAgentSubmitOptions } from "./agent.js";

export interface AgentChildControls {
  send(input: AgentChildAgentInput): Promise<void>;
  interrupt(reason?: string): Promise<void>;
}

export interface AgentChildProjectionHandle {
  invocationId: string;
  sessionId: string;
  cwd: string;
  taskId?: string;
  worktree?: { path: string; branch: string };
  state?: unknown;
}

export interface AgentChildRunProjection {
  runId?: string;
  host: AgentRunHost;
  state?: unknown;
}

export interface AgentChildProjection {
  createChild(input: {
    invocationId: string;
    parentScope: AgentRunScope;
    spawn: AgentChildAgentSpawnInput;
    controls: AgentChildControls;
  }): Promise<AgentChildProjectionHandle>;
  startRun(
    child: AgentChildProjectionHandle,
    content: string,
    signal: AbortSignal,
  ): Promise<AgentChildRunProjection>;
  finishRun(
    child: AgentChildProjectionHandle,
    run: AgentChildRunProjection,
    result: AgentChildAgentResult,
  ): Promise<void>;
  closeChild(child: AgentChildProjectionHandle, result: AgentChildAgentResult): Promise<void>;
}

interface ChildInvocationRecord {
  agent: OpenHarnessAgent;
  child: AgentChildProjectionHandle;
  projection?: AgentChildProjection;
  parentHost: AgentRunHost;
  abortController?: AbortController;
  followUps: string[];
  result: Promise<AgentChildAgentResult>;
  lastResult?: AgentChildAgentResult;
  parentAbortHandler?: () => void;
  closed: boolean;
}

export interface AgentChildManagerOptions {
  settings: Settings;
  createAgent(options: {
    settings: Settings;
    cwd: string;
    sessionId: string;
    overrides: {
      model?: string;
      systemPrompt?: string;
      permissionMode?: "default" | "plan" | "full_auto";
      allowedTools?: string[];
      disallowedTools?: string[];
      maxTurns?: number;
      effort?: "low" | "medium" | "high";
    };
  }): Promise<OpenHarnessAgent>;
}

export class AgentChildManager {
  private readonly invocations = new Map<string, ChildInvocationRecord>();

  constructor(private readonly options: AgentChildManagerOptions) {}

  createHost(parentHost: AgentRunHost, projection?: AgentChildProjection): AgentChildAgentHost {
    return {
      spawnChildAgent: (input) => this.spawn(parentHost, input, projection),
      sendChildInput: (invocationId, input) => this.send(invocationId, input),
      interruptChildAgent: (invocationId, reason) => this.interrupt(invocationId, reason),
      awaitChildAgent: (invocationId) => this.awaitResult(invocationId),
    };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.invocations.keys()].map((id) => this.dispose(id)));
  }

  private async spawn(
    parentHost: AgentRunHost,
    input: AgentChildAgentSpawnInput,
    projection?: AgentChildProjection,
  ): Promise<AgentChildAgentInvocation> {
    const invocationId = `child_${randomUUID()}`;
    const controls: AgentChildControls = {
      send: (childInput) => this.send(invocationId, childInput),
      interrupt: (reason) => this.interrupt(invocationId, reason),
    };
    const child = projection
      ? await projection.createChild({
          invocationId,
          parentScope: parentHost.scope,
          spawn: input,
          controls,
        })
      : {
          invocationId,
          sessionId: input.sessionId ?? `agent_session_${randomUUID()}`,
          cwd: input.cwd,
        };
    let agent: OpenHarnessAgent;
    try {
      agent = await this.options.createAgent({
        settings: this.options.settings,
        cwd: child.cwd,
        sessionId: child.sessionId,
        overrides: {
          model: input.model,
          systemPrompt: input.systemPrompt,
          permissionMode: input.permissionMode,
          allowedTools: input.allowedTools,
          disallowedTools: input.disallowedTools,
          maxTurns: input.maxTurns,
          effort: input.effort === "low" || input.effort === "medium" || input.effort === "high"
            ? input.effort
            : undefined,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await projection?.closeChild(child, { status: "failed", output: message, error: message }).catch(() => {});
      throw error;
    }
    const record: ChildInvocationRecord = {
      agent,
      child,
      projection,
      parentHost,
      followUps: [],
      result: Promise.resolve({ status: "completed", output: "" }),
      closed: false,
    };
    this.invocations.set(invocationId, record);
    const parentAbortHandler = () => {
      void this.interrupt(invocationId, "Parent run interrupted");
    };
    record.parentAbortHandler = parentAbortHandler;
    parentHost.scope.signal.addEventListener("abort", parentAbortHandler, { once: true });
    if (parentHost.scope.signal.aborted) {
      await this.interrupt(invocationId, "Parent run interrupted");
      throw new Error("Parent run interrupted");
    }
    record.result = this.run(record, input.prompt);

    return {
      id: invocationId,
      taskId: child.taskId,
      sessionId: child.sessionId,
      result: record.result,
      ...(child.worktree ? { worktree: child.worktree } : {}),
    };
  }

  private async send(invocationId: string, input: AgentChildAgentInput): Promise<void> {
    const record = this.get(invocationId);
    if (record.abortController) {
      record.followUps.push(input.content);
      return;
    }
    record.result = this.run(record, input.content);
  }

  private async interrupt(invocationId: string, reason?: string): Promise<void> {
    const record = this.invocations.get(invocationId);
    if (!record || record.closed) return;
    record.closed = true;
    this.detachParentAbort(record);
    record.abortController?.abort(reason ?? "Child agent interrupted");
    const result: AgentChildAgentResult = {
      status: "stopped",
      output: reason ?? "Child agent stopped",
    };
    await record.agent.close().catch(() => {});
    await record.projection?.closeChild(record.child, result).catch(() => {});
    this.invocations.delete(invocationId);
  }

  private async awaitResult(invocationId: string): Promise<AgentChildAgentResult> {
    return await this.get(invocationId).result;
  }

  private async run(record: ChildInvocationRecord, content: string): Promise<AgentChildAgentResult> {
    const controller = new AbortController();
    record.abortController = controller;
    const runProjection = record.projection
      ? await record.projection.startRun(record.child, content, controller.signal)
      : {
          host: createStandaloneChildHost(record.parentHost, record.child, controller.signal),
        };
    let output = "";
    let result: AgentChildAgentResult;
    try {
      const options: OpenHarnessAgentSubmitOptions = {
        signal: controller.signal,
        host: runProjection.host,
        childProjection: record.projection,
        pullFollowUps: () => record.followUps.splice(0),
      };
      for await (const event of record.agent.submitMessage(content, options)) {
        if (event.type === "text_delta") output += event.delta;
      }
      result = { status: "completed", output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = controller.signal.aborted
        ? { status: "interrupted", output, error: message }
        : { status: "failed", output: output || message, error: message };
    } finally {
      record.abortController = undefined;
    }
    await record.projection?.finishRun(record.child, runProjection, result);
    record.lastResult = result;
    return result;
  }

  private get(invocationId: string): ChildInvocationRecord {
    const record = this.invocations.get(invocationId);
    if (!record) throw new Error(`Child agent invocation not found: ${invocationId}`);
    return record;
  }

  private async dispose(invocationId: string): Promise<void> {
    const record = this.invocations.get(invocationId);
    if (!record || record.closed) return;
    if (record.abortController) {
      await this.interrupt(invocationId, "Parent agent closed");
      return;
    }
    record.closed = true;
    this.detachParentAbort(record);
    await record.agent.close().catch(() => {});
    await record.projection?.closeChild(
      record.child,
      record.lastResult ?? { status: "completed", output: "" },
    ).catch(() => {});
    this.invocations.delete(invocationId);
  }

  private detachParentAbort(record: ChildInvocationRecord): void {
    if (!record.parentAbortHandler) return;
    record.parentHost.scope.signal.removeEventListener("abort", record.parentAbortHandler);
    record.parentAbortHandler = undefined;
  }
}

function createStandaloneChildHost(
  parentHost: AgentRunHost,
  child: AgentChildProjectionHandle,
  signal: AbortSignal,
): AgentRunHost {
  return {
    scope: {
      sessionId: child.sessionId,
      inputId: `input_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      cwd: child.cwd,
      traceId: randomUUID(),
      signal,
    },
    emitEvent: (event) => parentHost.emitEvent(event),
    emitStreamEvent: () => {},
    requestPermission: (request) => parentHost.requestPermission(request),
  };
}
