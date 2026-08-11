import { randomUUID } from "node:crypto";

import type {
  AgentChildController,
  AgentChildDirectory,
  AgentChildHandle,
  AgentChildInput,
  AgentChildInvocation,
  AgentChildResult,
  AgentChildSpawnInput,
  AgentInputReceipt,
  AgentRunHandle,
  AgentRunScope,
  Settings,
} from "@openharness/core";
import { AgentRunNotAcceptingInputError } from "@openharness/core";

import type { OpenHarnessAgent, OpenHarnessAgentOptions } from "./agent.js";
import {
  createDefaultChildEnvironmentProvider,
  type AgentChildEnvironmentLease,
  type AgentChildEnvironmentProvider,
} from "./child-environment.js";
import type { AgentEventBus } from "./event-source.js";

export type { AgentChildEnvironmentLease, AgentChildEnvironmentProvider } from "./child-environment.js";

interface ChildRecord {
  id: string;
  sessionId: string;
  cwd: string;
  spawn: AgentChildSpawnInput;
  parentScope: AgentRunScope;
  lease: AgentChildEnvironmentLease;
  createAgent(): Promise<OpenHarnessAgent>;
  agent?: OpenHarnessAgent;
  suspendedHistory?: ReturnType<OpenHarnessAgent["getHistory"]>;
  idleTimer?: ReturnType<typeof setTimeout>;
  suspending?: Promise<void>;
  abortController?: AbortController;
  currentRun?: AgentRunHandle;
  result: Promise<AgentChildResult>;
  startChain: Promise<void>;
  lastResult?: AgentChildResult;
  parentAbortHandler?: () => void;
  aliases: Set<string>;
  requests: Map<string, { input: AgentChildInput; receipt: Promise<AgentInputReceipt> }>;
  state: AgentChildHandle["state"];
  closePromise?: Promise<void>;
  handle: ChildHandle;
}

export interface AgentChildManagerOptions {
  settings: Settings;
  cwd: string;
  idleTtlMs?: number;
  eventBus: AgentEventBus;
  directory?: AgentChildRegistry;
  environment?: AgentChildEnvironmentProvider;
  createAgent(
    options: OpenHarnessAgentOptions,
    identity: { childId: string; parentSessionId: string; parentRunId: string },
  ): Promise<OpenHarnessAgent>;
}

/** Shared live-handle index for the complete descendant tree of one root agent. */
export class AgentChildRegistry implements AgentChildDirectory {
  private readonly byId = new Map<string, AgentChildHandle>();
  private readonly bySessionId = new Map<string, AgentChildHandle>();

  register(handle: AgentChildHandle): void {
    const existingId = this.byId.get(handle.id);
    const existingSession = this.bySessionId.get(handle.sessionId);
    if ((existingId && existingId !== handle) || (existingSession && existingSession !== handle)) {
      throw new Error(`Child agent identity is already live: ${handle.id}/${handle.sessionId}`);
    }
    this.byId.set(handle.id, handle);
    this.bySessionId.set(handle.sessionId, handle);
  }

  unregister(handle: AgentChildHandle): void {
    if (this.byId.get(handle.id) === handle) this.byId.delete(handle.id);
    if (this.bySessionId.get(handle.sessionId) === handle) this.bySessionId.delete(handle.sessionId);
  }

  get(childId: string): AgentChildHandle | undefined {
    return this.byId.get(childId);
  }

  getBySessionId(sessionId: string): AgentChildHandle | undefined {
    return this.bySessionId.get(sessionId);
  }

  list(): AgentChildHandle[] {
    return [...this.byId.values()];
  }
}

export class AgentChildManager implements AgentChildDirectory {
  private readonly records = new Map<string, ChildRecord>();
  private readonly aliases = new Map<string, string>();
  private readonly environment: AgentChildEnvironmentProvider;
  private readonly directory: AgentChildRegistry;

  constructor(private readonly options: AgentChildManagerOptions) {
    this.environment = options.environment ?? createDefaultChildEnvironmentProvider();
    this.directory = options.directory ?? new AgentChildRegistry();
  }

  get cwd(): string {
    return this.options.cwd;
  }

  createController(parentScope: AgentRunScope): AgentChildController {
    return {
      spawnChildAgent: (input) => this.spawn(parentScope, input),
      sendChildInput: (childId, input) => this.send(childId, input),
      interruptChildAgent: (childId, reason) => this.interrupt(childId, reason),
      awaitChildAgent: (childId) => this.awaitResult(childId),
    };
  }

  get(childId: string): AgentChildHandle | undefined {
    return this.find(childId)?.handle;
  }

  getBySessionId(sessionId: string): AgentChildHandle | undefined {
    return this.find(sessionId)?.handle;
  }

  list(): AgentChildHandle[] {
    return [...this.records.values()].map((record) => record.handle);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map((id) => this.close(id, "Parent agent closed")));
  }

  private async spawn(parentScope: AgentRunScope, input: AgentChildSpawnInput): Promise<AgentChildInvocation> {
    const childId = `child_${randomUUID()}`;
    const sessionId = input.sessionId ?? `agent_session_${randomUUID()}`;
    const lease = await this.environment.acquire(input, childId);
    const record = {} as ChildRecord;
    const handle = new ChildHandle(this, () => record);
    Object.assign(record, {
      id: childId,
      sessionId,
      cwd: lease.cwd,
      spawn: input,
      parentScope,
      lease,
      createAgent: () => this.options.createAgent({
        settings: this.options.settings,
        cwd: lease.cwd,
        sessionId,
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
      }, {
        childId,
        parentSessionId: parentScope.sessionId,
        parentRunId: parentScope.runId,
      }),
      result: Promise.resolve({ status: "completed", output: "" }),
      startChain: Promise.resolve(),
      aliases: new Set<string>(),
      requests: new Map(),
      state: "starting",
      handle,
    } satisfies Partial<ChildRecord>);

    this.records.set(childId, record);
    this.registerAlias(record, childId);
    this.registerAlias(record, sessionId);
    this.registerAlias(record, `${input.agent}@${input.team ?? "default"}`);

    let announced = false;
    try {
      this.directory.register(handle);
      await this.emitChild(record, {
        type: "child.created",
        data: {
          childId,
          sessionId,
          spawn: input,
          cwd: lease.cwd,
          ...(lease.worktree ? { worktree: lease.worktree } : {}),
        },
      });
      announced = true;
      record.agent = await record.createAgent();
      const parentAbortHandler = () => {
        void this.interrupt(childId, "Parent run interrupted").catch(() => {});
      };
      record.parentAbortHandler = parentAbortHandler;
      parentScope.signal.addEventListener("abort", parentAbortHandler, { once: true });
      if (parentScope.signal.aborted) {
        await this.interrupt(childId, "Parent run interrupted");
        throw new Error("Parent run interrupted");
      }
      const receipt = await this.beginRun(record, { content: input.prompt });
      return {
        id: childId,
        sessionId,
        inputId: receipt.inputId,
        runId: receipt.runId,
        result: record.result,
        ...(lease.worktree ? { worktree: lease.worktree } : {}),
      };
    } catch (error) {
      await this.closeRecord(record, failedResult(error), announced);
      throw error;
    }
  }

  async send(childId: string, input: AgentChildInput): Promise<AgentInputReceipt> {
    const record = this.require(childId);
    if (record.state === "closed") throw new Error(`Child agent is closed: ${childId}`);
    if (input.id) {
      const existing = record.requests.get(input.id);
      if (existing) {
        if (!sameChildInput(existing.input, input)) throw new Error(`Child input id is already used: ${input.id}`);
        return await existing.receipt;
      }
      const receipt = this.sendToRecord(record, input);
      record.requests.set(input.id, { input, receipt });
      return await receipt;
    }
    return await this.sendToRecord(record, input);
  }

  async interrupt(childId: string, reason?: string): Promise<void> {
    await this.close(childId, reason ?? "Child agent interrupted");
  }

  async close(childId: string, reason?: string): Promise<void> {
    const record = this.find(childId);
    if (!record) return;
    if (record.closePromise) return await record.closePromise;
    const closing = (async () => {
      record.abortController?.abort(reason ?? "Child agent closed");
      await record.currentRun?.interrupt(reason ?? "Child agent closed");
      const settled = await record.result.catch((error) => failedResult(error));
      const result = record.currentRun
        ? settled
        : record.lastResult ?? { status: "stopped" as const, output: reason ?? "Child agent stopped" };
      await this.closeRecord(record, result, true);
    })();
    record.closePromise = closing;
    await closing;
  }

  private async sendToRecord(record: ChildRecord, input: AgentChildInput): Promise<AgentInputReceipt> {
    const activeRun = record.currentRun;
    if (input.delivery !== "queue" && activeRun) {
      try {
        return await activeRun.steer(input);
      } catch (error) {
        if (!(error instanceof AgentRunNotAcceptingInputError)) throw error;
        await activeRun.result.catch(() => {});
      }
    }
    let receipt: AgentInputReceipt | undefined;
    const scheduled = record.startChain.then(async () => {
      await record.result.catch(() => {});
      if (record.state === "closed") throw new Error(`Child agent is closed: ${record.id}`);
      receipt = await this.beginRun(record, input);
    });
    record.startChain = scheduled.then(() => {}, () => {});
    await scheduled;
    return receipt!;
  }

  private async beginRun(record: ChildRecord, input: AgentChildInput): Promise<AgentInputReceipt> {
    const agent = await this.ensureAgent(record);
    const controller = new AbortController();
    record.abortController = controller;
    record.state = "running";
    const ids = {
      inputId: input.id ?? `input_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      traceId: input.traceId ?? randomUUID(),
    };
    const run = agent.submitMessage(input.content, {
      ids,
      signal: controller.signal,
      delivery: input.delivery ?? "queue",
    });
    record.currentRun = run;
    const result = run.result.then<AgentChildResult>((completed) => ({
      status: "completed",
      output: completed.output,
    })).catch<AgentChildResult>((error) => controller.signal.aborted
      ? { status: "interrupted", output: "", error: errorMessage(error) }
      : failedResult(error));
    record.result = result.finally(() => {
      if (record.abortController === controller) record.abortController = undefined;
      if (record.currentRun === run) record.currentRun = undefined;
      if (record.state !== "closed") record.state = "idle";
    }).then((settled) => {
      record.lastResult = settled;
      this.scheduleSuspend(record);
      return settled;
    });
    void record.result.catch(() => {});
    await run.started;
    return { sessionId: record.sessionId, inputId: ids.inputId, runId: ids.runId };
  }

  private async awaitResult(childId: string): Promise<AgentChildResult> {
    return await this.require(childId).result;
  }

  private async ensureAgent(record: ChildRecord): Promise<OpenHarnessAgent> {
    this.clearIdleTimer(record);
    await record.suspending;
    if (record.agent) return record.agent;
    const agent = await record.createAgent();
    if (record.suspendedHistory) agent.loadHistory(record.suspendedHistory);
    record.agent = agent;
    record.state = "idle";
    await this.emitChild(record, {
      type: "child.resumed",
      data: { childId: record.id, sessionId: record.sessionId },
    });
    return agent;
  }

  private scheduleSuspend(record: ChildRecord): void {
    const idleTtlMs = this.options.idleTtlMs ?? 5 * 60_000;
    if (idleTtlMs <= 0 || record.state === "closed") return;
    this.clearIdleTimer(record);
    record.idleTimer = setTimeout(() => {
      record.idleTimer = undefined;
      if (record.state !== "idle" || !record.agent) return;
      const agent = record.agent;
      const suspending = (async () => {
        record.suspendedHistory = agent.getHistory();
        await agent.close().catch(() => {});
        if (record.agent === agent) record.agent = undefined;
        record.state = "suspended";
        await this.emitChild(record, {
          type: "child.suspended",
          data: { childId: record.id, sessionId: record.sessionId },
        });
      })().finally(() => {
        if (record.suspending === suspending) record.suspending = undefined;
      });
      record.suspending = suspending;
      void suspending.catch(() => {});
    }, idleTtlMs);
    record.idleTimer.unref?.();
  }

  private async closeRecord(record: ChildRecord, result: AgentChildResult, emit: boolean): Promise<void> {
    if (record.state === "closed" && !this.records.has(record.id)) return;
    record.state = "closed";
    this.detachParentAbort(record);
    this.clearIdleTimer(record);
    await record.suspending;
    await record.agent?.close().catch(() => {});
    record.agent = undefined;
    await record.lease.release(result).catch(() => {});
    try {
      if (emit) {
        await this.emitChild(record, {
          type: "child.closed",
          data: { childId: record.id, sessionId: record.sessionId, result },
        });
      }
    } finally {
      this.deleteRecord(record);
    }
  }

  private async emitChild(record: ChildRecord, event: Parameters<AgentEventBus["emit"]>[0]): Promise<void> {
    await this.options.eventBus.emit(event, {
      agentId: record.parentScope.agentId,
      sessionId: record.parentScope.sessionId,
      inputId: record.parentScope.inputId,
      runId: record.parentScope.runId,
      traceId: record.parentScope.traceId,
      childId: record.id,
    });
  }

  private find(value: string): ChildRecord | undefined {
    const id = this.aliases.get(value) ?? value;
    return this.records.get(id);
  }

  private require(value: string): ChildRecord {
    const record = this.find(value);
    if (!record) throw new Error(`Child agent not found: ${value}`);
    return record;
  }

  private registerAlias(record: ChildRecord, alias: string): void {
    record.aliases.add(alias);
    this.aliases.set(alias, record.id);
  }

  private deleteRecord(record: ChildRecord): void {
    this.directory.unregister(record.handle);
    this.records.delete(record.id);
    for (const alias of record.aliases) {
      if (this.aliases.get(alias) === record.id) this.aliases.delete(alias);
    }
  }

  private clearIdleTimer(record: ChildRecord): void {
    if (!record.idleTimer) return;
    clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
  }

  private detachParentAbort(record: ChildRecord): void {
    if (!record.parentAbortHandler) return;
    record.parentScope.signal.removeEventListener("abort", record.parentAbortHandler);
    record.parentAbortHandler = undefined;
  }
}

class ChildHandle implements AgentChildHandle {
  constructor(
    private readonly manager: AgentChildManager,
    private readonly record: () => ChildRecord,
  ) {}

  get id(): string { return this.record().id; }
  get sessionId(): string { return this.record().sessionId; }
  get state(): AgentChildHandle["state"] { return this.record().state; }
  get result(): Promise<AgentChildResult> { return this.record().result; }
  send(input: AgentChildInput): Promise<AgentInputReceipt> { return this.manager.send(this.id, input); }
  interrupt(reason?: string): Promise<void> { return this.manager.interrupt(this.id, reason); }
  close(): Promise<void> { return this.manager.close(this.id); }
}

function sameChildInput(left: AgentChildInput, right: AgentChildInput): boolean {
  return left.content === right.content &&
    (left.delivery ?? "steer") === (right.delivery ?? "steer") &&
    JSON.stringify(left.metadata ?? {}) === JSON.stringify(right.metadata ?? {});
}

function failedResult(error: unknown): AgentChildResult {
  const message = errorMessage(error);
  return { status: "failed", output: message, error: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
