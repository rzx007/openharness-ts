import type {
  AgentChildControls,
  AgentChildInputReceipt,
} from "@openharness/agent-runtime";
import type { AgentChildAgentInput } from "@openharness/core";

interface LiveChildAgentEntry {
  invocationId: string;
  controls: AgentChildControls;
}

/** Routes daemon commands to framework-owned child controls without owning their lifecycle. */
export class LiveChildAgentRegistry {
  private readonly entries = new Map<string, LiveChildAgentEntry>();

  register(sessionId: string, invocationId: string, controls: AgentChildControls): void {
    if (this.entries.has(sessionId)) {
      throw new Error(`Child agent is already live for session: ${sessionId}`);
    }
    this.entries.set(sessionId, { invocationId, controls });
  }

  unregister(sessionId: string, invocationId: string): void {
    const current = this.entries.get(sessionId);
    if (current?.invocationId === invocationId) this.entries.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  async send(sessionId: string, input: AgentChildAgentInput): Promise<AgentChildInputReceipt | undefined> {
    const current = this.entries.get(sessionId);
    return current ? await current.controls.send(input) : undefined;
  }

  async interrupt(sessionId: string, reason?: string): Promise<boolean> {
    const current = this.entries.get(sessionId);
    if (!current) return false;
    await current.controls.interrupt(reason);
    return true;
  }
}
