import { isPathInsideOrEqual, type ProjectRecord, type SessionStore } from "@openharness/services";

import type { AgentPool } from "../agent/agent-pool.js";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";
import type { SessionEventPublisher } from "../session/session-event-publisher.js";
import type { SessionRunEngine } from "../session/session-run-engine.js";

export class ProjectApplicationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ProjectApplicationError";
  }
}

export interface ProjectApplicationServiceContext {
  store: SessionStore;
  runEngine: Pick<SessionRunEngine, "hasWork">;
  agentPool: Pick<AgentPool, "close" | "hasActiveWorkForSession">;
  liveChildren: Pick<LiveChildAgentDirectory, "has">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

/**
 * Project mutations that must stay consistent with warm agents and live runs.
 * Rebind rewrites durable session cwd values, so warm agents keyed to the old
 * path have to be closed first or later prompts keep writing to the old tree.
 */
export class ProjectApplicationService {
  constructor(private readonly context: ProjectApplicationServiceContext) {}

  async rebindProject(projectId: string, path: string): Promise<ProjectRecord> {
    const project = this.context.store.getProject(projectId);
    if (!project) throw new ProjectApplicationError(404, `Project not found: ${projectId}`);

    const affected = this.context.store
      .listSessions({ includeArchived: true })
      .filter((session) => session.projectId === projectId && isPathInsideOrEqual(project.path, session.cwd));

    for (const session of affected) {
      if (session.status === "running" || session.status === "closing") {
        throw new ProjectApplicationError(409, "Cannot rebind project while a session is active");
      }
      if (this.context.runEngine.hasWork(session.id)) {
        throw new ProjectApplicationError(409, "Cannot rebind project while a session run is active");
      }
      if (this.context.liveChildren.has(session.id)) {
        throw new ProjectApplicationError(409, "Cannot rebind project while a live child agent is active");
      }
      if (this.context.agentPool.hasActiveWorkForSession(session.id)) {
        throw new ProjectApplicationError(409, "Cannot rebind project while a session runtime is busy");
      }
    }

    for (const session of affected) {
      await this.context.agentPool.close(session.id);
    }

    const before = this.context.events.checkpoint();
    try {
      const rebound = this.context.store.rebindProject(projectId, path);
      this.context.events.publishSince(before);
      return rebound;
    } catch (error) {
      throw new ProjectApplicationError(
        400,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
