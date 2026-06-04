import { describe, it, expect } from "vitest";
import { MemoryManager, tokenize } from "../src/index.js";

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
    await mgr.add("alpha doc", ["docs"]);
    await mgr.add("beta doc", ["docs"]);
    await mgr.add("alpha code", ["code"]);
    const results = await mgr.search({ query: "alpha", tags: ["docs"] });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("alpha doc");
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

describe("tokenize", () => {
  it("keeps ASCII words of length >= 3 and lowercases them", () => {
    expect(tokenize("Hello World").sort()).toEqual(["hello", "world"]);
  });

  it("drops ASCII words shorter than 3 chars", () => {
    expect(tokenize("a an the cat")).toEqual(["the", "cat"]);
  });

  it("splits each CJK ideograph into its own token", () => {
    expect(tokenize("数据库").sort()).toEqual(["数", "据", "库"].sort());
  });

  it("mixes ASCII words and CJK characters", () => {
    const tokens = tokenize("redis 缓存 cfg");
    expect(tokens).toContain("redis");
    expect(tokens).toContain("cfg");
    expect(tokens).toContain("缓");
    expect(tokens).toContain("存");
    expect(tokens).toHaveLength(4);
  });

  it("de-duplicates repeated tokens", () => {
    expect(tokenize("cat cat 猫 猫").sort()).toEqual(["cat", "猫"]);
  });
});

describe("MemoryManager search tokenization", () => {
  it("matches a memory containing the queried Chinese text", async () => {
    const mgr = new MemoryManager();
    await mgr.add("用户偏好使用中文回复");
    await mgr.add("user prefers english responses");
    const results = await mgr.search({ query: "中文" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("用户偏好使用中文回复");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches a full Chinese sentence query against partial overlap", async () => {
    const mgr = new MemoryManager();
    await mgr.add("项目使用 pnpm 管理依赖");
    await mgr.add("无关记忆");
    const results = await mgr.search({ query: "依赖管理" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("项目使用 pnpm 管理依赖");
  });

  it("still matches English word queries", async () => {
    const mgr = new MemoryManager();
    await mgr.add("hello world");
    await mgr.add("goodbye world");
    const results = await mgr.search({ query: "hello" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("hello world");
  });

  it("matches body content, not just metadata", async () => {
    const mgr = new MemoryManager();
    await mgr.add("deployment runs on kubernetes cluster");
    const results = await mgr.search({ query: "kubernetes" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toContain("kubernetes");
  });

  it("weights metadata matches higher than body matches", async () => {
    const mgr = new MemoryManager();
    const bodyMatch = await mgr.add("apple in body text");
    const metaMatch = await mgr.add("unrelated content", undefined, {
      topic: "apple",
    });
    const results = await mgr.search({ query: "apple" });
    expect(results).toHaveLength(2);
    const meta = results.find((r) => r.entry.id === metaMatch.id)!;
    const body = results.find((r) => r.entry.id === bodyMatch.id)!;
    expect(meta.score).toBeGreaterThan(body.score);
  });
});
