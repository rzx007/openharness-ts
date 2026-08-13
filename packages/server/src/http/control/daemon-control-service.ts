import type { SessionStore } from "@openharness/services";

import type { HookInfo } from "../../application/settings-api.js";
import type { SessionRunEngine } from "../session/session-run-engine.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { DaemonOperationGate, DaemonOperationLease } from "./daemon-operation-gate.js";
import { countByStatus, type OpenHarnessRuntimeSnapshot } from "../support.js";

export interface DaemonControlServiceContext {
  store: SessionStore;
  runEngine: Pick<
    SessionRunEngine,
    "activeRunId" | "hasActiveRunsForCwd" | "hasAnyActiveRuns" | "queuedRunIds" | "stopAndDrain"
  >;
  agentPool: AgentPool;
  operationGate: DaemonOperationGate;
  startedAt: number;
  sseClientCount(): number;
}

/**
 * Daemon 控制面：runtime 快照、按 cwd/全局关闭 runtime、是否有活跃 run、
 * hooks 等检查能力；供 /health、settings/plugin 等路由在写配置前做 barrier。
 */
export class DaemonControlService {
  constructor(private readonly context: DaemonControlServiceContext) {}

  get runtimeInspectionAvailable(): boolean {
    return this.context.agentPool.configured;
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
      warmAgentCount: this.context.agentPool.size,
      coordinator: { activeRunCount, queuedRunCount },
    };
  }

  hasAnyActiveRuns(): boolean {
    return this.context.runEngine.hasAnyActiveRuns() || this.context.agentPool.hasActiveWork();
  }

  hasActiveRunsForCwd(cwd: string): boolean {
    return this.context.runEngine.hasActiveRunsForCwd(cwd) || this.context.agentPool.hasActiveWorkForCwd(cwd);
  }

  acquireGlobalMutation(): DaemonOperationLease | undefined {
    return this.context.operationGate.tryEnterBarrier({ kind: "global" }, () => !this.hasAnyActiveRuns());
  }

  acquireCwdMutation(cwd: string): DaemonOperationLease | undefined {
    return this.context.operationGate.tryEnterBarrier({ kind: "cwd", cwd }, () => !this.hasActiveRunsForCwd(cwd));
  }

  async closeAllRuntimes(): Promise<void> {
    await this.context.agentPool.closeAll();
  }

  async closeRuntimesForCwd(cwd: string): Promise<void> {
    await this.context.agentPool.closeForCwd(cwd);
  }

  async shutdown(): Promise<void> {
    await this.context.operationGate.beginShutdown();
    const failures: unknown[] = [];
    try {
      await this.context.runEngine.stopAndDrain();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.context.agentPool.closeAll();
    } catch (error) {
      failures.push(error);
    } finally {
      this.context.operationGate.markClosed();
    }
    throwFailures(failures, "Daemon shutdown failed");
  }

  sessionExists(sessionId: string): boolean {
    return this.context.store.getSession(sessionId) !== undefined;
  }

  async inspectRuntimeHooks(sessionId: string): Promise<HookInfo[]> {
    const session = this.context.store.getSession(sessionId);
    if (!session) return [];
    const lease = this.context.operationGate.enter({ sessionId, cwd: session.cwd });
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      return agent.inspect().hooks.map((hook) => ({ ...hook, origin: "runtime" as const }));
    } finally {
      lease.release();
    }
  }
}

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}
