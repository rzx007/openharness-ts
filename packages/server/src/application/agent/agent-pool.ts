import type { OpenHarnessAgent } from "@openharness/agent-runtime";
import type { SessionStore } from "@openharness/services";
import type {
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/protocol";

import type { LoadDaemonAgent } from "../../daemon/daemon-agent.js";

export interface AgentPoolContext {
  store: Pick<SessionStore, "getSession" | "listMessageParts" | "listMessages" | "listSessions">;
  loadAgent?: LoadDaemonAgent;
  isSessionExternallyOwned?(sessionId: string): boolean;
}

interface AgentPoolEntry {
  promise: Promise<OpenHarnessAgent>;
  agent?: OpenHarnessAgent;
  state: "active" | "closing";
  closePromise?: Promise<void>;
}

/** One warm framework agent per pool-owned durable session; live children stay framework-owned. */
export class AgentPool {
  private readonly agents = new Map<string, AgentPoolEntry>();

  constructor(private readonly context: AgentPoolContext) {}

  get configured(): boolean {
    return this.context.loadAgent !== undefined;
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
    await this.acquireSession(sessionId).catch(() => {});
  }

  async get(sessionId: string): Promise<OpenHarnessAgent | undefined> {
    const entry = this.agents.get(sessionId);
    return entry?.state === "active" ? await entry.promise : undefined;
  }

  async acquireSession(sessionId: string): Promise<OpenHarnessAgent> {
    return await this.acquire(sessionId);
  }

  private async acquire(sessionId: string): Promise<OpenHarnessAgent> {
    if (!this.configured) throw new Error("Agent runtime is not configured");
    if (this.context.isSessionExternallyOwned?.(sessionId)) {
      throw new Error(`Session runtime is owned by a live child agent: ${sessionId}`);
    }
    const current = this.context.store.getSession(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    if (current.status === "closing" || current.status === "archived") {
      throw new Error(`Session runtime is not available: ${sessionId}`);
    }
    const existing = this.agents.get(sessionId);
    if (existing?.state === "active") return await existing.promise;
    if (existing?.closePromise) {
      await existing.closePromise;
      return await this.acquire(sessionId);
    }

    const entry = { state: "active" as const } as AgentPoolEntry;
    const promise = this.create(
      current,
      this.context.store.listMessages(sessionId),
      this.context.store.listMessageParts(sessionId),
      entry,
    ).catch((error) => {
      if (entry.state === "active" && this.agents.get(sessionId) === entry) this.agents.delete(sessionId);
      throw error;
    });
    entry.promise = promise;
    this.agents.set(sessionId, entry);
    return await promise;
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.agents.get(sessionId);
    if (!entry) return;
    if (entry.closePromise) return await entry.closePromise;
    entry.state = "closing";
    const closing = (async () => {
      try {
        let agent: OpenHarnessAgent;
        try {
          agent = await entry.promise;
        } catch {
          // Failed creation has no usable agent resource to close.
          return;
        }
        await agent.close();
      } finally {
        entry.agent = undefined;
        if (this.agents.get(sessionId) === entry) this.agents.delete(sessionId);
      }
    })();
    entry.closePromise = closing;
    await closing;
  }

  async closeForCwd(cwd: string): Promise<void> {
    const sessions = this.context.store.listSessions({ cwd, includeArchived: true });
    await this.closeSessions(sessions.map((session) => session.id), `Agent pool cleanup failed for cwd: ${cwd}`);
  }

  async closeAll(): Promise<void> {
    await this.closeSessions([...this.agents.keys()], "Agent pool cleanup failed");
  }

  private async create(
    session: SessionRecord,
    history: SessionMessageRecord[],
    parts: SessionMessagePartRecord[],
    entry: AgentPoolEntry,
  ): Promise<OpenHarnessAgent> {
    const loadAgent = this.context.loadAgent;
    if (!loadAgent) throw new Error("Agent runtime is not configured");
    const agent = await loadAgent({ session, history, parts });
    entry.agent = agent;
    return agent;
  }

  private entryHasActiveWork(entry: AgentPoolEntry): boolean {
    if (entry.state === "closing" || !entry.agent) return true;
    if (entry.agent.state !== "idle") return true;
    return entry.agent.children.list().some((child) =>
      child.state === "starting" || child.state === "running" || child.state === "closing");
  }

  private async closeSessions(sessionIds: string[], message: string): Promise<void> {
    const settled = await Promise.allSettled(sessionIds.map((sessionId) => this.close(sessionId)));
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
  }
}
