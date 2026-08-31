import type { Settings } from "@openharness/core";
import type { SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../../shared/observability.js";

export interface SessionPostRunMaintenanceContext {
  store: SessionStore;
  getSettings(cwd: string): Promise<Settings | undefined>;
  sessionMemoryWriter?: (cwd: string, messages: SessionMessageLike[], sessionId: string) => void;
  contextExtractor?: (input: {
    sessionId: string;
    runId: string;
    cwd: string;
    projectId?: string;
    messages: SessionMessageLike[];
  }) => Promise<void>;
  log(event: ObservabilityEvent): void;
}

export interface SessionMessageLike {
  role: string;
  content: string;
}

/** Best-effort Context and continuity maintenance after one root run has completed. */
export class SessionPostRunMaintenance {
  constructor(private readonly context: SessionPostRunMaintenanceContext) {}

  async run(sessionId: string, runId: string): Promise<void> {
    try {
      await this.runMaintenance(sessionId, runId);
    } catch (error) {
      this.context.log({
        level: "warn",
        event: "session.post_run_maintenance_failed",
        sessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runMaintenance(sessionId: string, runId: string): Promise<void> {
    const session = this.context.store.getSession(sessionId);
    const run = this.context.store.getRun(runId);
    if (!session || run?.status !== "completed") return;

    const messages = transcriptMessages(this.context.store, sessionId);

    const settings = await this.context.getSettings(session.cwd);
    if (!settings) return;

    if (settings.sessionContinuity?.enabled !== false) {
      await this.bestEffort("session.continuity.checkpoint_failed", sessionId, runId, async () => {
        this.context.sessionMemoryWriter?.(session.cwd, messages, sessionId);
      });
    }

    if (settings.context?.enabled !== false && settings.context?.automaticExtractionEnabled !== false) {
      await this.bestEffort("session.context.auto_extract_failed", sessionId, runId, async () => {
        await this.context.contextExtractor?.({
          sessionId,
          runId,
          cwd: session.cwd,
          ...(session.projectId ? { projectId: session.projectId } : {}),
          messages,
        });
      });
    }
  }

  private async bestEffort(
    event: string,
    sessionId: string,
    runId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.context.log({
        level: "warn",
        event,
        sessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function transcriptMessages(store: SessionStore, sessionId: string): SessionMessageLike[] {
  return store.listMessages(sessionId)
    .sort((a, b) => a.seq - b.seq)
    .map((message) => {
      const content = store.listMessageParts(sessionId, { messageId: message.id })
        .sort((a, b) => a.seq - b.seq)
        .map((part) => part.text ?? (typeof part.output === "string" ? part.output : ""))
        .filter(Boolean)
        .join("\n");
      return { role: message.role, content };
    })
    .filter((message) => message.content.length > 0);
}
