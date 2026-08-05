import type { SessionStore } from "@openharness/services";

import type { HookInfo } from "../settings-api.js";
import type { SessionRunEngine } from "./session-run-engine.js";
import type { SessionRuntimePool } from "./session-runtime-pool.js";
import { countByStatus, type OpenHarnessRuntimeSnapshot } from "./support.js";

export interface DaemonControlServiceContext {
  store: SessionStore;
  runEngine: Pick<
    SessionRunEngine,
    "activeRunId" | "hasActiveRunsForCwd" | "hasAnyActiveRuns" | "queuedRunIds"
  >;
  runtimePool: SessionRuntimePool;
  startedAt: number;
  sseClientCount(): number;
}

/** Shared daemon status, runtime invalidation, and inspection control plane. */
export class DaemonControlService {
  constructor(private readonly context: DaemonControlServiceContext) {}

  get runtimeInspectionAvailable(): boolean {
    return this.context.runtimePool.configured;
  }

  runtimeSnapshot(): OpenHarnessRuntimeSnapshot {
    const sessions = this.context.store.listSessions({ includeArchived: true });
    const runs = sessions.flatMap((session) => this.context.store.listRuns(session.id));
    const tasks = sessions.flatMap((session) => this.context.store.listSessionTasks(session.id));
    const permissions = this.context.store.listPermissionRequests();
    const activeRunCount = sessions.filter(
      (session) => this.context.runEngine.activeRunId(session.id) !== undefined,
    ).length;
    const queuedRunCount = sessions.reduce(
      (count, session) => count + this.context.runEngine.queuedRunIds(session.id).length,
      0,
    );
    const now = Date.now();
    return {
      startedAt: this.context.startedAt,
      uptimeMs: now - this.context.startedAt,
      sessions: { total: sessions.length, byStatus: countByStatus(sessions) },
      runs: { total: runs.length, byStatus: countByStatus(runs) },
      tasks: { total: tasks.length, byStatus: countByStatus(tasks) },
      permissions: { total: permissions.length, byStatus: countByStatus(permissions) },
      sseClientCount: this.context.sseClientCount(),
      warmRuntimeCount: this.context.runtimePool.size,
      coordinator: { activeRunCount, queuedRunCount },
    };
  }

  hasAnyActiveRuns(): boolean {
    return this.context.runEngine.hasAnyActiveRuns();
  }

  hasActiveRunsForCwd(cwd: string): boolean {
    return this.context.runEngine.hasActiveRunsForCwd(cwd);
  }

  async closeAllRuntimes(): Promise<void> {
    await this.context.runtimePool.closeAll();
  }

  async closeRuntimesForCwd(cwd: string): Promise<void> {
    await this.context.runtimePool.closeForCwd(cwd);
  }

  sessionExists(sessionId: string): boolean {
    return this.context.store.getSession(sessionId) !== undefined;
  }

  async inspectRuntimeHooks(sessionId: string): Promise<HookInfo[]> {
    await this.context.runtimePool.warm(sessionId);
    const runtime = await this.context.runtimePool.get(sessionId);
    if (!runtime?.inspect) return [];
    return (await runtime.inspect()).hooks ?? [];
  }
}
