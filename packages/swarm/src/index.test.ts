import { describe, it, expect } from "vitest";
import { TeamRegistry, Mailbox, BackendRegistry, getBackendRegistry } from "./index.js";
import type { TeamMember, SwarmMessage, SwarmBackend, SpawnResult, TeammateSpawnConfig, TeammateMessage } from "./index.js";

describe("TeamRegistry", () => {
  it("registers a team", () => {
    const reg = new TeamRegistry();
    const team = reg.register("t1", "Alpha");
    expect(team.id).toBe("t1");
    expect(team.name).toBe("Alpha");
    expect(team.members.size).toBe(0);
  });

  it("throws on duplicate team id", () => {
    const reg = new TeamRegistry();
    reg.register("t1", "Alpha");
    expect(() => reg.register("t1", "Beta")).toThrow("already registered");
  });

  it("unregisters a team", () => {
    const reg = new TeamRegistry();
    reg.register("t1", "Alpha");
    reg.unregister("t1");
    expect(reg.get("t1")).toBeUndefined();
  });

  it("getAll returns all teams", () => {
    const reg = new TeamRegistry();
    reg.register("t1", "Alpha");
    reg.register("t2", "Beta");
    expect(reg.getAll()).toHaveLength(2);
  });

  it("adds and removes members", () => {
    const reg = new TeamRegistry();
    reg.register("t1", "Alpha");
    const member: TeamMember = { id: "m1", name: "Agent1", role: "worker" };
    reg.addMember("t1", member);
    const team = reg.get("t1")!;
    expect(team.members.size).toBe(1);
    expect(team.members.get("m1")!.name).toBe("Agent1");

    reg.removeMember("t1", "m1");
    expect(team.members.size).toBe(0);
  });

  it("addMember throws for unknown team", () => {
    const reg = new TeamRegistry();
    expect(() => reg.addMember("nope", { id: "m1", name: "A", role: "w" })).toThrow("not found");
  });

  it("removeMember throws for unknown team", () => {
    const reg = new TeamRegistry();
    expect(() => reg.removeMember("nope", "m1")).toThrow("not found");
  });
});

describe("Mailbox", () => {
  it("sends and receives messages", () => {
    const box = new Mailbox();
    const msg: SwarmMessage = {
      id: "m1",
      from: "a",
      to: "b",
      content: "hello",
      timestamp: Date.now(),
    };
    box.send(msg);
    const received = box.receive("b");
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("hello");
  });

  it("receive clears the queue", () => {
    const box = new Mailbox();
    box.send({ id: "m1", from: "a", to: "b", content: "hi", timestamp: 0 });
    box.receive("b");
    expect(box.receive("b")).toHaveLength(0);
  });

  it("receive returns empty for unknown agent", () => {
    const box = new Mailbox();
    expect(box.receive("nope")).toHaveLength(0);
  });

  it("peek does not clear queue", () => {
    const box = new Mailbox();
    box.send({ id: "m1", from: "a", to: "b", content: "hi", timestamp: 0 });
    box.peek("b");
    expect(box.hasMessages("b")).toBe(true);
  });

  it("hasMessages returns false for empty queue", () => {
    const box = new Mailbox();
    expect(box.hasMessages("b")).toBe(false);
  });

  it("clear removes all messages for agent", () => {
    const box = new Mailbox();
    box.send({ id: "m1", from: "a", to: "b", content: "hi", timestamp: 0 });
    box.clear("b");
    expect(box.hasMessages("b")).toBe(false);
  });

  it("broadcast sends to multiple agents", () => {
    const box = new Mailbox();
    const msgs = box.broadcast("leader", ["a", "b", "c"], "meeting now");
    expect(msgs).toHaveLength(3);
    expect(box.receive("a")).toHaveLength(1);
    expect(box.receive("b")).toHaveLength(1);
    expect(box.receive("c")).toHaveLength(1);
  });
});

const mockBackend: SwarmBackend = {
  async spawn(config: TeammateSpawnConfig): Promise<SpawnResult> {
    return { success: true, agentId: `agent-${config.name}`, taskId: "task-1", backendType: "mock" };
  },
  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {},
  async terminate(agentId: string): Promise<void> {},
};

describe("BackendRegistry", () => {
  it("registers and retrieves backend", () => {
    const reg = new BackendRegistry();
    reg.register("mock", mockBackend);
    expect(reg.getExecutor("mock")).toBe(mockBackend);
  });

  it("throws for unknown backend", () => {
    const reg = new BackendRegistry();
    expect(() => reg.getExecutor("nope")).toThrow("not found");
  });

  it("returns first backend when no name given", () => {
    const reg = new BackendRegistry();
    reg.register("mock", mockBackend);
    expect(reg.getExecutor()).toBe(mockBackend);
  });

  it("throws when no backends registered", () => {
    const reg = new BackendRegistry();
    expect(() => reg.getExecutor()).toThrow("No backends");
  });

  it("lists registered backends", () => {
    const reg = new BackendRegistry();
    reg.register("a", mockBackend);
    reg.register("b", mockBackend);
    expect(reg.list()).toEqual(["a", "b"]);
  });
});

describe("getBackendRegistry", () => {
  it("returns a singleton", () => {
    const a = getBackendRegistry();
    const b = getBackendRegistry();
    expect(a).toBe(b);
  });
});
