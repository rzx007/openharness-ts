import { describe, expect, it, vi } from "vitest";

import { AgentEventBus, AgentEventDeliveryError } from "./event-source.js";

const context = { agentId: "a1", sessionId: "s1", runId: "r1", inputId: "i1", traceId: "t1" };

describe("AgentEventBus", () => {
  it("delivers one ordered reliable event stream", async () => {
    const seen: Array<{ type: string; sequence: number }> = [];
    const bus = new AgentEventBus(async (event) => {
      seen.push({ type: event.type, sequence: event.sequence });
    });

    await Promise.all([
      bus.emit({ type: "run.started", data: {} }, context),
      bus.emit({ type: "output.text.delta", data: { delta: "hi" } }, context),
    ]);

    expect(seen).toEqual([
      { type: "run.started", sequence: 1 },
      { type: "output.text.delta", sequence: 2 },
    ]);
  });

  it("surfaces reliable sink failures", async () => {
    const bus = new AgentEventBus(vi.fn(async () => { throw new Error("store unavailable"); }));
    await expect(bus.emit({ type: "run.started", data: {} }, context))
      .rejects.toBeInstanceOf(AgentEventDeliveryError);
  });

  it("isolates multiple observer failures from execution", async () => {
    const bus = new AgentEventBus();
    const seen = vi.fn();
    const unsubscribe = bus.subscribe(async () => { throw new Error("observer failed"); });
    bus.subscribe(seen);

    await expect(bus.emit({ type: "run.started", data: {} }, context)).resolves.toBeDefined();
    expect(seen).toHaveBeenCalledOnce();

    unsubscribe();
    await bus.emit({ type: "run.completed", data: { output: "ok" } }, context);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("does not let a slow observer block reliable event delivery", async () => {
    const sink = vi.fn();
    const bus = new AgentEventBus(sink);
    bus.subscribe(() => new Promise<void>(() => {}));

    await expect(bus.emit({ type: "run.started", data: {} }, context)).resolves.toBeDefined();
    expect(sink).toHaveBeenCalledOnce();
  });
});
