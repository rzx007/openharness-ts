import { describe, it, expect } from "vitest";
import { BridgeManager } from "../src/index.js";

describe("BridgeManager", () => {
  it("creates a session", async () => {
    const mgr = new BridgeManager();
    const session = await mgr.createSession("test");
    expect(session.name).toBe("test");
    expect(session.status).toBe("active");
    expect(session.id).toBeTruthy();
  });

  it("gets a session by id", async () => {
    const mgr = new BridgeManager();
    const created = await mgr.createSession("test");
    const found = mgr.getSession(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("test");
  });

  it("returns undefined for nonexistent session", () => {
    const mgr = new BridgeManager();
    expect(mgr.getSession("nope")).toBeUndefined();
  });

  it("lists all sessions", async () => {
    const mgr = new BridgeManager();
    await mgr.createSession("a");
    await mgr.createSession("b");
    const list = mgr.listSessions();
    expect(list).toHaveLength(2);
  });

  it("closes a session", async () => {
    const mgr = new BridgeManager();
    const created = await mgr.createSession("test");
    await mgr.closeSession(created.id);
    const found = mgr.getSession(created.id);
    expect(found!.status).toBe("closed");
  });

  it("closeSession is no-op for nonexistent id", async () => {
    const mgr = new BridgeManager();
    await mgr.closeSession("nope");
  });

  it("creates multiple sessions with unique ids", async () => {
    const mgr = new BridgeManager();
    const a = await mgr.createSession("a");
    const b = await mgr.createSession("b");
    expect(a.id).not.toBe(b.id);
  });
});
