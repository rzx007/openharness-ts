import type {
  AgentChildAgentHost,
  AgentChildAgentInput,
  AgentChildAgentInvocation,
  AgentChildAgentResult,
  AgentChildAgentSpawnInput,
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

  constructor(private readonly context: DaemonRuntimeHostPortContext) {
    this.scope = context.scope;
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

  async spawnChildAgent(input: AgentChildAgentSpawnInput): Promise<AgentChildAgentInvocation> {
    return await this.context.childAgentHost.spawnChildAgent(input);
  }

  async sendChildInput(invocationId: string, input: AgentChildAgentInput): Promise<void> {
    await this.context.childAgentHost.sendChildInput(invocationId, input);
  }

  async interruptChildAgent(invocationId: string, reason?: string): Promise<void> {
    await this.context.childAgentHost.interruptChildAgent(invocationId, reason);
  }

  async awaitChildAgent(invocationId: string): Promise<AgentChildAgentResult> {
    return await this.context.childAgentHost.awaitChildAgent(invocationId);
  }
}
