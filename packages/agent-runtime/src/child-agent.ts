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
  send(input: AgentChildAgentInput): Promise<AgentChildInputReceipt>;
  interrupt(reason?: string): Promise<void>;
}

export interface AgentChildInputReceipt {
  sessionId: string;
  inputId?: string;
  runId?: string;
  result: Promise<AgentChildAgentResult>;
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
  inputId?: string;
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
    input: AgentChildAgentInput,
    signal: AbortSignal,
  ): Promise<AgentChildRunProjection>;
  finishRun(
    child: AgentChildProjectionHandle,
    run: AgentChildRunProjection,
    result: AgentChildAgentResult,
  ): Promise<void>;
  failRunStart?(child: AgentChildProjectionHandle, result: AgentChildAgentResult): Promise<void>;
  closeChild(child: AgentChildProjectionHandle, result: AgentChildAgentResult): Promise<void>;
}

interface ChildInvocationRecord {
  agent?: OpenHarnessAgent;
  createAgent(): Promise<OpenHarnessAgent>;
  suspendedHistory?: ReturnType<OpenHarnessAgent["getHistory"]>;
  idleTimer?: ReturnType<typeof setTimeout>;
  suspending?: Promise<void>;
  child: AgentChildProjectionHandle;
  projection?: AgentChildProjection;
  parentHost: AgentRunHost;
  abortController?: AbortController;
  acceptingFollowUps: boolean;
  followUps: string[];
  result: Promise<AgentChildAgentResult>;
  currentReceipt?: Promise<AgentChildInputReceipt>;
  startChain: Promise<void>;
  lastResult?: AgentChildAgentResult;
  parentAbortHandler?: () => void;
  aliases: Set<string>;
  requests: Map<string, { input: AgentChildAgentInput; receipt: Promise<AgentChildInputReceipt> }>;
  closePromise?: Promise<void>;
  closed: boolean;
}

export interface AgentChildManagerOptions {
  settings: Settings;
  idleTtlMs?: number;
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
  private readonly aliases = new Map<string, string>();

  constructor(private readonly options: AgentChildManagerOptions) {}

  createHost(parentHost: AgentRunHost, projection?: AgentChildProjection): AgentChildAgentHost {
    return {
      spawnChildAgent: (input) => this.spawn(parentHost, input, projection),
      sendChildInput: async (invocationId, input) => {
        await this.send(invocationId, input);
      },
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
    const ready = deferred<void>();
    void ready.promise.catch(() => {});
    const controls: AgentChildControls = {
      send: async (childInput) => {
        await ready.promise;
        return await this.send(invocationId, childInput);
      },
      interrupt: async (reason) => {
        await ready.promise;
        await this.interrupt(invocationId, reason);
      },
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
    const createAgent = () => this.options.createAgent({
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
    let agent: OpenHarnessAgent;
    try {
      agent = await createAgent();
    } catch (error) {
      ready.reject(error);
      const message = error instanceof Error ? error.message : String(error);
      await projection?.closeChild(child, { status: "failed", output: message, error: message }).catch(() => {});
      throw error;
    }
    const record: ChildInvocationRecord = {
      agent,
      createAgent,
      child,
      projection,
      parentHost,
      acceptingFollowUps: false,
      followUps: [],
      result: Promise.resolve({ status: "completed", output: "" }),
      startChain: Promise.resolve(),
      aliases: new Set(),
      requests: new Map(),
      closed: false,
    };
    this.invocations.set(invocationId, record);
    this.registerAlias(record, invocationId);
    if (child.taskId) this.registerAlias(record, child.taskId);
    this.registerAlias(record, `${input.agent}@${input.team ?? "default"}`);
    ready.resolve();
    const parentAbortHandler = () => {
      void this.interrupt(invocationId, "Parent run interrupted");
    };
    record.parentAbortHandler = parentAbortHandler;
    parentHost.scope.signal.addEventListener("abort", parentAbortHandler, { once: true });
    if (parentHost.scope.signal.aborted) {
      await this.interrupt(invocationId, "Parent run interrupted");
      throw new Error("Parent run interrupted");
    }
    const receipt = await this.beginRun(record, { content: input.prompt });

    return {
      id: invocationId,
      taskId: child.taskId,
      sessionId: child.sessionId,
      result: receipt.result,
      ...(child.worktree ? { worktree: child.worktree } : {}),
    };
  }

  private send(invocationId: string, input: AgentChildAgentInput): Promise<AgentChildInputReceipt> {
    const record = this.get(invocationId);
    if (record.closed) throw new Error(`Child agent invocation is closed: ${invocationId}`);
    if (input.id) {
      const existing = record.requests.get(input.id);
      if (existing) {
        if (!sameChildInput(existing.input, input)) {
          throw new Error(`Child input id is already used: ${input.id}`);
        }
        return existing.receipt;
      }
      const receipt = this.sendToRecord(record, input);
      record.requests.set(input.id, { input, receipt });
      return receipt;
    }
    return this.sendToRecord(record, input);
  }

  private async sendToRecord(
    record: ChildInvocationRecord,
    input: AgentChildAgentInput,
  ): Promise<AgentChildInputReceipt> {
    if (input.delivery !== "queue" && record.acceptingFollowUps && record.currentReceipt) {
      record.followUps.push(input.content);
      return await record.currentReceipt;
    }
    return await this.queueRun(record, input);
  }

  private async interrupt(invocationId: string, reason?: string): Promise<void> {
    const resolved = this.aliases.get(invocationId) ?? invocationId;
    const record = this.invocations.get(resolved);
    if (!record) return;
    if (record.closePromise) return await record.closePromise;
    if (record.closed) return;
    record.closed = true;
    this.detachParentAbort(record);
    const closing = this.interruptRecord(record, reason);
    record.closePromise = closing;
    await closing;
  }

  private async interruptRecord(record: ChildInvocationRecord, reason?: string): Promise<void> {
    const wasRunning = record.abortController !== undefined;
    record.abortController?.abort(reason ?? "Child agent interrupted");
    const settled = await record.result.catch((error) => ({
      status: "failed" as const,
      output: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error.message : String(error),
    }));
    const result = wasRunning
      ? settled
      : { status: "stopped" as const, output: reason ?? "Child agent stopped" };
    this.clearIdleTimer(record);
    await record.suspending;
    await record.agent?.close().catch(() => {});
    record.agent = undefined;
    await record.projection?.closeChild(record.child, result).catch(() => {});
  }

  private async awaitResult(invocationId: string): Promise<AgentChildAgentResult> {
    return await this.get(invocationId).result;
  }

  private async beginRun(record: ChildInvocationRecord, input: AgentChildAgentInput): Promise<AgentChildInputReceipt> {
    const started = deferred<Omit<AgentChildInputReceipt, "result">>();
    const result = this.run(record, input, started.resolve);
    record.result = result;
    const receipt = started.promise.then((value) => ({ ...value, result }));
    record.currentReceipt = receipt;
    return await receipt;
  }

  private async queueRun(record: ChildInvocationRecord, input: AgentChildAgentInput): Promise<AgentChildInputReceipt> {
    let receipt: AgentChildInputReceipt | undefined;
    const scheduled = record.startChain.then(async () => {
      await record.result.catch(() => {});
      if (record.closed) throw new Error(`Child agent invocation is closed: ${record.child.invocationId}`);
      receipt = await this.beginRun(record, input);
    });
    record.startChain = scheduled.then(() => {}, () => {});
    await scheduled;
    return receipt!;
  }

  private async run(
    record: ChildInvocationRecord,
    input: AgentChildAgentInput,
    started: (receipt: Omit<AgentChildInputReceipt, "result">) => void,
  ): Promise<AgentChildAgentResult> {
    const controller = new AbortController();
    record.abortController = controller;
    let runProjection: AgentChildRunProjection | undefined;
    let output = "";
    let result: AgentChildAgentResult;
    try {
      const agent = await this.ensureAgent(record);
      runProjection = record.projection
        ? await record.projection.startRun(record.child, input, controller.signal)
        : {
            host: createStandaloneChildHost(record.parentHost, record.child, controller.signal),
          };
      started({
        sessionId: record.child.sessionId,
        inputId: runProjection.inputId ?? runProjection.host.scope.inputId,
        runId: runProjection.runId ?? runProjection.host.scope.runId,
      });
      record.acceptingFollowUps = true;
      const options: OpenHarnessAgentSubmitOptions = {
        signal: controller.signal,
        host: runProjection.host,
        childProjection: record.projection,
        pullFollowUps: () => record.followUps.splice(0),
      };
      let content: string | undefined = input.content;
      while (content !== undefined) {
        record.acceptingFollowUps = true;
        for await (const event of agent.submitMessage(content, options)) {
          if (event.type === "text_delta") output += event.delta;
        }
        record.acceptingFollowUps = false;
        content = record.followUps.shift();
      }
      result = { status: "completed", output };
    } catch (error) {
      record.acceptingFollowUps = false;
      const message = error instanceof Error ? error.message : String(error);
      result = controller.signal.aborted
        ? { status: "interrupted", output, error: message }
        : { status: "failed", output: output || message, error: message };
      if (!runProjection) {
        started({ sessionId: record.child.sessionId });
        await record.projection?.failRunStart?.(record.child, result).catch(() => {});
      }
    }
    if (runProjection) {
      try {
        await record.projection?.finishRun(record.child, runProjection, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { status: "failed", output: output || message, error: message };
      }
    }
    if (record.abortController === controller) record.abortController = undefined;
    record.currentReceipt = undefined;
    record.lastResult = result;
    this.scheduleSuspend(record);
    return result;
  }

  private get(invocationId: string): ChildInvocationRecord {
    const resolved = this.aliases.get(invocationId) ?? invocationId;
    const record = this.invocations.get(resolved);
    if (!record) throw new Error(`Child agent invocation not found: ${invocationId}`);
    return record;
  }

  private async dispose(invocationId: string): Promise<void> {
    const record = this.invocations.get(invocationId);
    if (!record) return;
    if (record.closed) {
      await record.closePromise;
      this.deleteRecord(record);
      return;
    }
    if (record.abortController) {
      await this.interrupt(invocationId, "Parent agent closed");
      this.deleteRecord(record);
      return;
    }
    record.closed = true;
    this.detachParentAbort(record);
    this.clearIdleTimer(record);
    await record.suspending;
    await record.agent?.close().catch(() => {});
    record.agent = undefined;
    await record.projection?.closeChild(
      record.child,
      record.lastResult ?? { status: "completed", output: "" },
    ).catch(() => {});
    this.deleteRecord(record);
  }

  private registerAlias(record: ChildInvocationRecord, alias: string): void {
    record.aliases.add(alias);
    this.aliases.set(alias, record.child.invocationId);
  }

  private deleteRecord(record: ChildInvocationRecord): void {
    this.clearIdleTimer(record);
    this.invocations.delete(record.child.invocationId);
    for (const alias of record.aliases) {
      if (this.aliases.get(alias) === record.child.invocationId) this.aliases.delete(alias);
    }
  }

  private async ensureAgent(record: ChildInvocationRecord): Promise<OpenHarnessAgent> {
    this.clearIdleTimer(record);
    await record.suspending;
    if (record.agent) return record.agent;
    const agent = await record.createAgent();
    try {
      if (record.suspendedHistory) agent.loadHistory(record.suspendedHistory);
      record.agent = agent;
      return agent;
    } catch (error) {
      await agent.close().catch(() => {});
      throw error;
    }
  }

  private scheduleSuspend(record: ChildInvocationRecord): void {
    const idleTtlMs = this.options.idleTtlMs ?? 5 * 60_000;
    if (idleTtlMs <= 0 || record.closed) return;
    this.clearIdleTimer(record);
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.closed || record.abortController || !record.agent) return;
      const agent = record.agent;
      const suspending = (async () => {
        try {
          record.suspendedHistory = agent.getHistory();
        } catch {
          return;
        }
        await agent.close().catch(() => {});
        if (record.agent === agent) record.agent = undefined;
      })().finally(() => {
        if (record.suspending === suspending) record.suspending = undefined;
      });
      record.suspending = suspending;
    }, idleTtlMs);
    record.idleTimer.unref?.();
  }

  private clearIdleTimer(record: ChildInvocationRecord): void {
    if (!record.idleTimer) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private detachParentAbort(record: ChildInvocationRecord): void {
    if (!record.parentAbortHandler) return;
    record.parentHost.scope.signal.removeEventListener("abort", record.parentAbortHandler);
    record.parentAbortHandler = undefined;
  }
}

function sameChildInput(left: AgentChildAgentInput, right: AgentChildAgentInput): boolean {
  return left.content === right.content &&
    (left.delivery ?? "steer") === (right.delivery ?? "steer") &&
    JSON.stringify(left.metadata ?? {}) === JSON.stringify(right.metadata ?? {});
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
