import type {
  AgentChildAgentHost,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunHost,
  AgentRunScope,
  AgentRuntimeEvent,
  StreamEvent,
} from "@openharness/core";

export interface DaemonRuntimeHostPortContext {
  scope: AgentRunScope;
  emitEvent(event: AgentRuntimeEvent): void | Promise<void>;
  emitStreamEvent(event: StreamEvent): void | Promise<void>;
  requestPermission(input: AgentPermissionRequest): Promise<AgentPermissionDecision>;
  childAgentHost: AgentChildAgentHost;
}

/**
 * Runtime host implementation for daemon-owned runs.
 */
export class DaemonRuntimeHostPort implements AgentRunHost {
  readonly scope: AgentRunScope;
  readonly childAgentHost: AgentChildAgentHost;

  constructor(private readonly context: DaemonRuntimeHostPortContext) {
    this.scope = context.scope;
    this.childAgentHost = context.childAgentHost;
  }

  emitEvent(event: AgentRuntimeEvent): void | Promise<void> {
    return this.context.emitEvent(event);
  }

  emitStreamEvent(event: StreamEvent): void | Promise<void> {
    return this.context.emitStreamEvent(event);
  }

  async requestPermission(input: AgentPermissionRequest): Promise<AgentPermissionDecision> {
    return await this.context.requestPermission(input);
  }
}
