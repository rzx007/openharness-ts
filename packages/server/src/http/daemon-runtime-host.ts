import type { StreamEvent } from "@openharness/core";

import type {
  ChildAgentInput,
  ChildAgentInvocation,
  ChildAgentResult,
  ChildAgentSpawnInput,
  PermissionDecision,
  PermissionRequestInput,
  RuntimeChildAgentHost,
  RuntimeHostEvent,
  RuntimeHostPort,
  RuntimeHostScope,
} from "../runtime-host.js";

export interface DaemonRuntimeHostPortContext {
  scope: RuntimeHostScope;
  emitEvent(event: RuntimeHostEvent): void | Promise<void>;
  emitStreamEvent(event: StreamEvent): void | Promise<void>;
  requestPermission(input: PermissionRequestInput): Promise<PermissionDecision>;
  childAgentHost: RuntimeChildAgentHost;
}

/**
 * Runtime host implementation for daemon-owned runs.
 */
export class DaemonRuntimeHostPort implements RuntimeHostPort {
  readonly scope: RuntimeHostScope;

  constructor(private readonly context: DaemonRuntimeHostPortContext) {
    this.scope = context.scope;
  }

  emitEvent(event: RuntimeHostEvent): void | Promise<void> {
    return this.context.emitEvent(event);
  }

  emitStreamEvent(event: StreamEvent): void | Promise<void> {
    return this.context.emitStreamEvent(event);
  }

  async requestPermission(input: PermissionRequestInput): Promise<PermissionDecision> {
    return await this.context.requestPermission(input);
  }

  async spawnChildAgent(input: ChildAgentSpawnInput): Promise<ChildAgentInvocation> {
    return await this.context.childAgentHost.spawnChildAgent(input);
  }

  async sendChildInput(invocationId: string, input: ChildAgentInput): Promise<void> {
    await this.context.childAgentHost.sendChildInput(invocationId, input);
  }

  async interruptChildAgent(invocationId: string, reason?: string): Promise<void> {
    await this.context.childAgentHost.interruptChildAgent(invocationId, reason);
  }

  async awaitChildAgent(invocationId: string): Promise<ChildAgentResult> {
    return await this.context.childAgentHost.awaitChildAgent(invocationId);
  }
}
