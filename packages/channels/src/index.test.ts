import { describe, it, expect } from "vitest";
import { EventBus } from "../src/bus/index.js";

describe("EventBus", () => {
  it("emits events to registered handlers", () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.on("test", (data) => received.push(data));
    bus.emit("test", "hello");
    expect(received).toEqual(["hello"]);
  });

  it("supports multiple handlers for same event", () => {
    const bus = new EventBus();
    let count = 0;
    bus.on("evt", () => count++);
    bus.on("evt", () => count++);
    bus.emit("evt", null);
    expect(count).toBe(2);
  });

  it("unsubscribe removes handler", () => {
    const bus = new EventBus();
    let called = false;
    const unsub = bus.on("evt", () => { called = true; });
    unsub();
    bus.emit("evt", null);
    expect(called).toBe(false);
  });

  it("does not call handlers for different events", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on("a", () => received.push("a"));
    bus.on("b", () => received.push("b"));
    bus.emit("a", null);
    expect(received).toEqual(["a"]);
  });

  it("removeAll with event removes only that event", () => {
    const bus = new EventBus();
    let a = false, b = false;
    bus.on("a", () => { a = true; });
    bus.on("b", () => { b = true; });
    bus.removeAll("a");
    bus.emit("a", null);
    bus.emit("b", null);
    expect(a).toBe(false);
    expect(b).toBe(true);
  });

  it("removeAll without arg removes all", () => {
    const bus = new EventBus();
    let a = false, b = false;
    bus.on("a", () => { a = true; });
    bus.on("b", () => { b = true; });
    bus.removeAll();
    bus.emit("a", null);
    bus.emit("b", null);
    expect(a).toBe(false);
    expect(b).toBe(false);
  });

  it("emit with no handlers is no-op", () => {
    const bus = new EventBus();
    expect(() => bus.emit("nope", null)).not.toThrow();
  });
});
