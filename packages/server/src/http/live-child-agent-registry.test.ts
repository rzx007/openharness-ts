import { describe, expect, it, vi } from "vitest";

import { LiveChildAgentRegistry } from "./live-child-agent-registry.js";

describe("LiveChildAgentRegistry", () => {
  it("routes by durable child session without taking ownership of the controls", async () => {
    const interrupt = vi.fn(async () => {});
    const receipt = {
      sessionId: "child-session",
      inputId: "input-1",
      runId: "run-1",
      result: Promise.resolve({ status: "completed" as const, output: "done" }),
    };
    const send = vi.fn(async () => receipt);
    const registry = new LiveChildAgentRegistry();
    registry.register("child-session", "child-invocation", {
      send,
      interrupt,
    });

    expect(registry.has("child-session")).toBe(true);
    await expect(registry.send("child-session", { content: "follow up" })).resolves.toBe(receipt);
    expect(send).toHaveBeenCalledWith({ content: "follow up" });
    await expect(registry.interrupt("child-session", "stop requested")).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledWith("stop requested");

    registry.unregister("child-session", "another-invocation");
    await expect(registry.interrupt("child-session")).resolves.toBe(true);
    registry.unregister("child-session", "child-invocation");
    expect(registry.has("child-session")).toBe(false);
    await expect(registry.interrupt("child-session")).resolves.toBe(false);
  });
});
