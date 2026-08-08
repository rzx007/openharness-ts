import type { RuntimeChildAgentHost, RuntimeHostScope } from "../runtime-host.js";
import type { ChildSessionHost } from "../runtime.js";
import { DaemonChildAgentHost } from "./daemon-child-agent-host.js";
import type { SessionTaskBridgeManager } from "./session-task-bridge.js";

export interface ChildAgentHostFactory {
  create(input: {
    scope: RuntimeHostScope;
    session: { id: string; cwd: string };
  }): RuntimeChildAgentHost;
}

export interface DaemonChildAgentHostFactoryContext {
  childSessionHost: ChildSessionHost;
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
      childSessionHost: this.context.childSessionHost,
      sessionTaskBridge: this.context.sessionTaskBridgeManager.createBridge(input.session),
    });
  }
}
