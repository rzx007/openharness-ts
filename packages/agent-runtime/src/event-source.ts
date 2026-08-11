import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentEventListener,
  AgentEventSource,
  AgentEventSubscription,
} from "@openharness/core";

export class AgentEventDeliveryError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AgentEventDeliveryError";
  }
}

export class AgentEventBus implements AgentEventSource {
  private listener?: AgentEventListener;
  private sequence = 0;
  private delivery: Promise<void> = Promise.resolve();

  subscribe(listener: AgentEventListener): AgentEventSubscription {
    if (this.listener) throw new Error("OpenHarnessAgent already has a required event subscriber");
    this.listener = listener;
    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.listener === listener) this.listener = undefined;
      },
    };
  }

  async emit(input: AgentEventInput, context: AgentEventContext): Promise<AgentEvent> {
    const event = {
      ...input,
      id: `agent_event_${randomUUID()}`,
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
      context,
    } as AgentEvent;
    const listener = this.listener;
    if (!listener) return event;

    const delivered = this.delivery.then(async () => {
      try {
        await listener(event);
      } catch (error) {
        throw new AgentEventDeliveryError(error);
      }
    });
    this.delivery = delivered.catch(() => {});
    await delivered;
    return event;
  }

  async drain(): Promise<void> {
    await this.delivery;
  }
}
