import { describe, expect, it, vi } from "vitest";

import { AgentEventBus, AgentEventDeliveryError } from "./event-source.js";

const context = { agentId: "a1", sessionId: "s1", runId: "r1", inputId: "i1", traceId: "t1" };

describe("AgentEventBus", () => {
  it("delivers one ordered required event stream", async () => {
    const bus = new AgentEventBus();
    const seen: Array<{ type: string; sequence: number }> = [];
    bus.subscribe(async (event) => { seen.push({ type: event.type, sequence: event.sequence }); });

    await Promise.all([
      bus.emit({ type: "run.started", data: {} }, context),
      bus.emit({ type: "output.text.delta", data: { delta: "hi" } }, context),
    ]);

    expect(seen).toEqual([
      { type: "run.started", sequence: 1 },
      { type: "output.text.delta", sequence: 2 },
    ]);
  });

  it("surfaces required listener failures", async () => {
    const bus = new AgentEventBus();
    bus.subscribe(vi.fn(async () => { throw new Error("store unavailable"); }));
    await expect(bus.emit({ type: "run.started", data: {} }, context))
      .rejects.toBeInstanceOf(AgentEventDeliveryError);
  });
});
