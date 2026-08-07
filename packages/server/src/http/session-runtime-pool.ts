import type { SessionStore } from "@openharness/services";

import type { SessionRuntime, SessionRuntimeFactory } from "../runtime.js";

export interface SessionRuntimePoolContext {
  store: Pick<SessionStore, "getSession" | "listMessageParts" | "listMessages" | "listSessions">;
  runtimeFactory?: SessionRuntimeFactory;
}

/**
 * One cached SessionRuntime per session. The pool owns creation, reuse, and
 * closing; run-scoped host capabilities are injected by SessionRunExecutor.
 */
export class SessionRuntimePool {
  private readonly runtimes = new Map<string, Promise<SessionRuntime>>();

  constructor(private readonly context: SessionRuntimePoolContext) {}

  get configured(): boolean {
    return this.context.runtimeFactory !== undefined;
  }

  get size(): number {
    return this.runtimes.size;
  }

  async warm(sessionId: string): Promise<void> {
    if (!this.configured || this.runtimes.has(sessionId)) return;
    const session = this.context.store.getSession(sessionId);
    if (!session || session.status === "archived") return;
    const history = this.context.store.listMessages(sessionId);
    const parts = this.context.store.listMessageParts(sessionId);
    await this.acquire(session, history, parts).catch(() => {});
  }

  async get(sessionId: string): Promise<SessionRuntime | undefined> {
    const runtime = this.runtimes.get(sessionId);
    return runtime ? await runtime : undefined;
  }

  async acquire(
    session: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["session"],
    history: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["history"],
    parts: Parameters<SessionRuntimeFactory["createRuntime"]>[0]["parts"],
  ): Promise<SessionRuntime> {
    const runtimeFactory = this.context.runtimeFactory;
    if (!runtimeFactory) throw new Error("Runtime factory is not configured");
    const existing = this.runtimes.get(session.id);
    if (existing) return await existing;

    const promise = runtimeFactory.createRuntime({ session, history, parts }).catch((error) => {
      if (this.runtimes.get(session.id) === promise) this.runtimes.delete(session.id);
      throw error;
    });
    this.runtimes.set(session.id, promise);
    return await promise;
  }

  async close(sessionId: string): Promise<void> {
    const runtimePromise = this.runtimes.get(sessionId);
    if (!runtimePromise) return;
    this.runtimes.delete(sessionId);
    try {
      const runtime = await runtimePromise;
      await runtime.close();
    } catch {
      // A runtime that failed during creation has no usable resource to close.
    }
  }

  async closeForCwd(cwd: string): Promise<void> {
    const sessions = this.context.store.listSessions({ cwd, includeArchived: true });
    await Promise.all(sessions.map((session) => this.close(session.id)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((sessionId) => this.close(sessionId)));
  }
}
