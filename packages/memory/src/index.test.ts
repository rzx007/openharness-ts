import { describe, it, expect } from "vitest";
import { MemoryManager } from "../src/index.js";

describe("MemoryManager", () => {
  it("adds and retrieves an entry", async () => {
    const mgr = new MemoryManager();
    const entry = await mgr.add("hello world", ["greeting"]);
    expect(entry.content).toBe("hello world");
    expect(entry.tags).toEqual(["greeting"]);
    const found = await mgr.get(entry.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe("hello world");
  });

  it("returns undefined for nonexistent entry", async () => {
    const mgr = new MemoryManager();
    expect(await mgr.get("nope")).toBeUndefined();
  });

  it("updates an entry", async () => {
    const mgr = new MemoryManager();
    const entry = await mgr.add("original");
    const updated = await mgr.update(entry.id, { content: "updated", tags: ["new"] });
    expect(updated!.content).toBe("updated");
    expect(updated!.tags).toEqual(["new"]);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(entry.createdAt);
  });

  it("update returns undefined for nonexistent entry", async () => {
    const mgr = new MemoryManager();
    expect(await mgr.update("nope", { content: "x" })).toBeUndefined();
  });

  it("deletes an entry", async () => {
    const mgr = new MemoryManager();
    const entry = await mgr.add("to delete");
    expect(await mgr.delete(entry.id)).toBe(true);
    expect(await mgr.get(entry.id)).toBeUndefined();
  });

  it("searches by content substring", async () => {
    const mgr = new MemoryManager();
    await mgr.add("hello world");
    await mgr.add("hello universe");
    await mgr.add("goodbye world");
    const results = await mgr.search({ query: "hello" });
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("search filters by tags", async () => {
    const mgr = new MemoryManager();
    await mgr.add("doc a", ["docs"]);
    await mgr.add("doc b", ["docs"]);
    await mgr.add("code a", ["code"]);
    const results = await mgr.search({ query: "a", tags: ["docs"] });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("doc a");
  });

  it("search respects limit", async () => {
    const mgr = new MemoryManager();
    for (let i = 0; i < 10; i++) {
      await mgr.add(`item ${i} hello`);
    }
    const results = await mgr.search({ query: "hello", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("getAll returns all entries", async () => {
    const mgr = new MemoryManager();
    await mgr.add("a");
    await mgr.add("b");
    expect((await mgr.getAll()).length).toBe(2);
  });

  it("clear removes all entries", async () => {
    const mgr = new MemoryManager();
    await mgr.add("a");
    await mgr.add("b");
    await mgr.clear();
    expect(mgr.count()).toBe(0);
  });

  it("evicts oldest entries when max exceeded", async () => {
    const mgr = new MemoryManager(3);
    const e1 = await mgr.add("first");
    await mgr.add("second");
    await mgr.add("third");
    await mgr.add("fourth");
    expect(mgr.count()).toBe(3);
    expect(await mgr.get(e1.id)).toBeUndefined();
  });
});
