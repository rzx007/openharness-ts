import type { RuntimeChildAgentHost, RuntimeHostScope } from "../runtime-host.js";
import type { ChildSessionHost } from "./child-agent-ports.js";
import { DaemonChildAgentHost } from "./daemon-child-agent-host.js";
import type { SessionApplicationService } from "./session-application-service.js";
import type { SessionTaskBridgeManager } from "./session-task-bridge.js";

type ChildSessionApplication = Pick<
  SessionApplicationService,
  | "admitPrompt"
  | "archiveSessionTree"
  | "awaitRun"
  | "closeRuntime"
  | "createChildSession"
  | "interruptSession"
>;

export interface ChildAgentHostFactory {
  create(input: {
    scope: RuntimeHostScope;
    session: { id: string; cwd: string };
  }): RuntimeChildAgentHost;
}

export interface DaemonChildAgentHostFactoryContext {
  childSessionApplication: () => ChildSessionApplication;
  sessionTaskBridgeManager: Pick<SessionTaskBridgeManager, "createBridge">;
}

export class DaemonChildAgentHostFactory implements ChildAgentHostFactory {
  constructor(private readonly context: DaemonChildAgentHostFactoryContext) {}

  create(input: {
    scope: RuntimeHostScope;
    session: { id: string; cwd: string };
  }): RuntimeChildAgentHost {
    return new DaemonChildAgentHost({
      scope: input.scope,
      childSessionHost: this.createChildSessionHost(),
      sessionTaskBridge: this.context.sessionTaskBridgeManager.createBridge(input.session),
    });
  }

  private createChildSessionHost(): ChildSessionHost {
    const application = this.context.childSessionApplication;
    return {
      createChildSession: async (input) => await application().createChildSession(input),
      admitPrompt: async (sessionId, content) => {
        const admitted = application().admitPrompt(sessionId, { content });
        return admitted.run ? { runId: admitted.run.id } : {};
      },
      awaitRun: async (sessionId, runId) => await application().awaitRun(sessionId, runId),
      interrupt: async (sessionId) => {
        application().interruptSession(sessionId);
      },
      closeRuntime: async (sessionId) => {
        await application().closeRuntime(sessionId);
      },
      archive: async (sessionId) => {
        await application().archiveSessionTree(sessionId);
      },
    };
  }
}
