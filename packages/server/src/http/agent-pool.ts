import type { OpenHarnessAgent, OpenHarnessAgentOptions } from "@openharness/agent-runtime";
import { createOpenHarnessAgent } from "@openharness/agent-runtime";
import type { Settings } from "@openharness/core";
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
}

/** One warm framework agent per durable daemon session. */
export class AgentPool {
  private readonly agents = new Map<string, Promise<OpenHarnessAgent>>();

  constructor(private readonly context: AgentPoolContext) {}

  get configured(): boolean {
    return this.context.createAgent !== undefined || this.context.settings !== undefined;
  }

  get size(): number {
    return this.agents.size;
  }

  async warm(sessionId: string): Promise<void> {
    if (!this.configured || this.agents.has(sessionId)) return;
    const session = this.context.store.getSession(sessionId);
    if (!session || session.status === "archived") return;
    await this.acquire(
      session,
      this.context.store.listMessages(sessionId),
      this.context.store.listMessageParts(sessionId),
    ).catch(() => {});
  }

  async get(sessionId: string): Promise<OpenHarnessAgent | undefined> {
    const agent = this.agents.get(sessionId);
    return agent ? await agent : undefined;
  }

  async acquire(
    session: SessionRecord,
    history: SessionMessageRecord[],
    parts: SessionMessagePartRecord[],
  ): Promise<OpenHarnessAgent> {
    if (!this.configured) throw new Error("Agent runtime is not configured");
    const existing = this.agents.get(session.id);
    if (existing) return await existing;

    const promise = this.create(session, history, parts).catch((error) => {
      if (this.agents.get(session.id) === promise) this.agents.delete(session.id);
      throw error;
    });
    this.agents.set(session.id, promise);
    return await promise;
  }

  async close(sessionId: string): Promise<void> {
    const agentPromise = this.agents.get(sessionId);
    if (!agentPromise) return;
    this.agents.delete(sessionId);
    try {
      await (await agentPromise).close();
    } catch {
      // Failed creation has no usable agent resource to close.
    }
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
  ): Promise<OpenHarnessAgent> {
    const settings = this.context.getSettings?.() ?? this.context.settings;
    const options: OpenHarnessAgentOptions = {
      ...(settings ? { settings } : {}),
      cwd: session.cwd,
      sessionId: session.id,
      overrides: runtimeOverridesFromSession(session),
    };
    if (!this.context.createAgent && !settings) throw new Error("Agent settings are not configured");
    const agent = this.context.createAgent
      ? await this.context.createAgent({ session, history, parts, options })
      : await createOpenHarnessAgent(options);
    try {
      agent.loadHistory(transcriptToAgentMessages(history, parts));
      return agent;
    } catch (error) {
      await agent.close();
      throw error;
    }
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
