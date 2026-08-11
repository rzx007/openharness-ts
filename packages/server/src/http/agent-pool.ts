import type { OpenHarnessAgent, OpenHarnessAgentOptions } from "@openharness/agent-runtime";
import { createOpenHarnessAgent } from "@openharness/agent-runtime";
import type { AgentEffects, AgentEventSubscription, Settings } from "@openharness/core";
import type { SessionStore } from "@openharness/services";
import type {
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/services/session-runtime/types";

import { transcriptToAgentMessages } from "./agent-transcript.js";

export interface CreateDaemonAgentContext {
  session: SessionRecord;
  history: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  options: OpenHarnessAgentOptions;
}

export type CreateDaemonAgent = (context: CreateDaemonAgentContext) => Promise<OpenHarnessAgent>;

export interface AgentPoolContext {
  store: Pick<SessionStore, "getSession" | "listMessageParts" | "listMessages" | "listSessions">;
  settings?: Settings;
  getSettings?: () => Settings;
  createAgent?: CreateDaemonAgent;
  isSessionExternallyOwned?(sessionId: string): boolean;
  effects?: AgentEffects;
  bindAgent?(agent: OpenHarnessAgent, session: SessionRecord): AgentEventSubscription;
}

interface AgentPoolEntry {
  promise: Promise<OpenHarnessAgent>;
  agent?: OpenHarnessAgent;
  subscription?: AgentEventSubscription;
  state: "active" | "closing";
  closePromise?: Promise<void>;
}

/** One warm framework agent per pool-owned durable session; live children stay framework-owned. */
export class AgentPool {
  private readonly agents = new Map<string, AgentPoolEntry>();

  constructor(private readonly context: AgentPoolContext) {}

  get configured(): boolean {
    return this.context.createAgent !== undefined || this.context.settings !== undefined;
  }

  get size(): number {
    return this.agents.size;
  }

  hasActiveWork(): boolean {
    return [...this.agents.values()].some((entry) => this.entryHasActiveWork(entry));
  }

  hasActiveWorkForSession(sessionId: string): boolean {
    const entry = this.agents.get(sessionId);
    return entry ? this.entryHasActiveWork(entry) : false;
  }

  hasActiveWorkForCwd(cwd: string): boolean {
    return this.context.store.listSessions({ cwd, includeArchived: true })
      .some((session) => this.hasActiveWorkForSession(session.id));
  }

  async warm(sessionId: string): Promise<void> {
    if (!this.configured || this.agents.has(sessionId) || this.context.isSessionExternallyOwned?.(sessionId)) return;
    const session = this.context.store.getSession(sessionId);
    if (!session || session.status === "closing" || session.status === "archived") return;
    await this.acquire(
      session,
      this.context.store.listMessages(sessionId),
      this.context.store.listMessageParts(sessionId),
    ).catch(() => {});
  }

  async get(sessionId: string): Promise<OpenHarnessAgent | undefined> {
    const entry = this.agents.get(sessionId);
    return entry?.state === "active" ? await entry.promise : undefined;
  }

  async acquireSession(sessionId: string): Promise<OpenHarnessAgent> {
    const session = this.context.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return await this.acquire(
      session,
      this.context.store.listMessages(sessionId),
      this.context.store.listMessageParts(sessionId),
    );
  }

  async acquire(
    session: SessionRecord,
    history: SessionMessageRecord[],
    parts: SessionMessagePartRecord[],
  ): Promise<OpenHarnessAgent> {
    if (!this.configured) throw new Error("Agent runtime is not configured");
    if (this.context.isSessionExternallyOwned?.(session.id)) {
      throw new Error(`Session runtime is owned by a live child agent: ${session.id}`);
    }
    const current = this.context.store.getSession(session.id);
    if (!current || current.status === "closing" || current.status === "archived") {
      throw new Error(`Session runtime is not available: ${session.id}`);
    }
    const existing = this.agents.get(session.id);
    if (existing?.state === "active") return await existing.promise;
    if (existing?.closePromise) {
      await existing.closePromise;
      const refreshed = this.context.store.getSession(session.id);
      if (!refreshed || refreshed.status === "closing" || refreshed.status === "archived") {
        throw new Error(`Session runtime is not available: ${session.id}`);
      }
      return await this.acquire(
        refreshed,
        this.context.store.listMessages(session.id),
        this.context.store.listMessageParts(session.id),
      );
    }

    const entry = { state: "active" as const } as AgentPoolEntry;
    const promise = this.create(session, history, parts, entry).catch((error) => {
      if (entry.state === "active" && this.agents.get(session.id) === entry) this.agents.delete(session.id);
      throw error;
    });
    entry.promise = promise;
    this.agents.set(session.id, entry);
    return await promise;
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    if (entry.closePromise) return await entry.closePromise;
    entry.state = "closing";
    const closing = (async () => {
      try {
        await (await entry.promise).close();
      } catch {
        // Failed creation has no usable agent resource to close.
      } finally {
        entry.subscription?.unsubscribe();
        entry.subscription = undefined;
        entry.agent = undefined;
        if (this.agents.get(sessionId) === entry) this.agents.delete(sessionId);
      }
    })();
    entry.closePromise = closing;
    await closing;
  }

  async closeForCwd(cwd: string): Promise<void> {
    const sessions = this.context.store.listSessions({ cwd, includeArchived: true });
    await Promise.all(sessions.map((session) => this.close(session.id)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.agents.keys()].map((sessionId) => this.close(sessionId)));
  }

  private async create(
    session: SessionRecord,
    history: SessionMessageRecord[],
    parts: SessionMessagePartRecord[],
    entry: AgentPoolEntry,
  ): Promise<OpenHarnessAgent> {
    const settings = this.context.getSettings?.() ?? this.context.settings;
    const options: OpenHarnessAgentOptions = {
      ...(settings ? { settings } : {}),
      cwd: session.cwd,
      sessionId: session.id,
      overrides: runtimeOverridesFromSession(session),
      ...(this.context.effects ? { effects: this.context.effects } : {}),
    };
    if (!this.context.createAgent && !settings) throw new Error("Agent settings are not configured");
    const agent = this.context.createAgent
      ? await this.context.createAgent({ session, history, parts, options })
      : await createOpenHarnessAgent(options);
    try {
      agent.loadHistory(transcriptToAgentMessages(history, parts));
      const subscription = this.context.bindAgent?.(agent, session);
      if (subscription) entry.subscription = subscription;
      entry.agent = agent;
      return agent;
    } catch (error) {
      entry.subscription?.unsubscribe();
      entry.subscription = undefined;
      await agent.close();
      throw error;
    }
  }

  private entryHasActiveWork(entry: AgentPoolEntry): boolean {
    if (entry.state === "closing" || !entry.agent) return true;
    if (entry.agent.state !== "idle") return true;
    return entry.agent.children.list().some((child) =>
      child.state === "starting" || child.state === "running" || child.state === "closing");
  }
}

function runtimeOverridesFromSession(session: SessionRecord): NonNullable<OpenHarnessAgentOptions["overrides"]> {
  const permissionMode = session.metadata.permissionMode;
  const effort = session.metadata.effort;
  return {
    model: session.model || undefined,
    permissionMode: permissionMode === "default" || permissionMode === "plan" || permissionMode === "full_auto"
      ? permissionMode
      : undefined,
    systemPrompt: typeof session.metadata.systemPrompt === "string"
      ? session.metadata.systemPrompt
      : undefined,
    maxTurns: typeof session.metadata.maxTurns === "number" ? session.metadata.maxTurns : undefined,
    allowedTools: Array.isArray(session.metadata.allowedTools)
      ? session.metadata.allowedTools.filter((tool): tool is string => typeof tool === "string")
      : undefined,
    disallowedTools: Array.isArray(session.metadata.disallowedTools)
      ? session.metadata.disallowedTools.filter((tool): tool is string => typeof tool === "string")
      : undefined,
    effort: effort === "low" || effort === "medium" || effort === "high" ? effort : undefined,
  };
}
