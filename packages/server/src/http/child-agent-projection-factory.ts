import type { AgentChildProjection } from "@openharness/agent-runtime";
import type { AgentRunScope } from "@openharness/core";
import type { SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../observability.js";
import type { StorePermissionBroker } from "../permission-broker.js";
import { DaemonChildAgentProjection } from "./daemon-child-agent-projection.js";
import type { SessionApplicationService } from "./session-application-service.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionTaskBridgeManager } from "./session-task-bridge.js";
import type { LiveChildAgentRegistry } from "./live-child-agent-registry.js";
import type { SessionTranscriptProjection } from "./transcript-projection.js";

export interface ChildAgentProjectionFactory {
  create(input: { scope: AgentRunScope; session: { id: string; cwd: string } }): AgentChildProjection;
}

export interface DaemonChildAgentProjectionFactoryContext {
  store: SessionStore;
  childSessionApplication: () => Pick<SessionApplicationService, "createChildSession">;
  liveChildren: Pick<LiveChildAgentRegistry, "register" | "unregister">;
  sessionTaskBridgeManager: Pick<SessionTaskBridgeManager, "createBridge">;
  permissionBroker: Pick<StorePermissionBroker, "ask">;
  transcriptProjection: SessionTranscriptProjection;
  events: Pick<SessionEventPublisher, "checkpoint" | "publish" | "publishSince">;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
}

export class DaemonChildAgentProjectionFactory implements ChildAgentProjectionFactory {
  constructor(private readonly context: DaemonChildAgentProjectionFactoryContext) {}

  create(input: { scope: AgentRunScope; session: { id: string; cwd: string } }): AgentChildProjection {
    return new DaemonChildAgentProjection({
      store: this.context.store,
      createChildSession: (child) => this.context.childSessionApplication().createChildSession(child),
      liveChildren: this.context.liveChildren,
      createTaskBridge: (session) => this.context.sessionTaskBridgeManager.createBridge(session),
      permissionBroker: this.context.permissionBroker,
      transcriptProjection: this.context.transcriptProjection,
      events: this.context.events,
      traceIdForRun: this.context.traceIdForRun,
      log: this.context.log,
    });
  }
}
