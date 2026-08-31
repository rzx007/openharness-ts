import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseContextDocument, type ContextEntryRecord } from "@openharness/context";
import { describe, expect, it } from "vitest";

import { MarkdownContextStore } from "../markdown-context-store.js";

const NOW = 1_788_166_800_000;

function entry(overrides: Partial<ContextEntryRecord> = {}): ContextEntryRecord {
  return {
    id: "ctx-color",
    title: "配色",
    scope: "user",
    scopeKey: "local-user",
    kind: "user_preference",
    semanticKey: "ui.design.color",
    topic: "ui-design",
    content: "使用项目真实设计系统色板。",
    normalizedContent: "使用项目真实设计系统色板",
    status: "active",
    sensitivity: "none",
    confidence: 0.99,
    importance: 0.8,
    origin: "explicit_user",
    useCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("MarkdownContextStore", () => {
  it("writes several related entries into one topic document", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-store-"));
    const store = new MarkdownContextStore({ root, now: () => NOW });

    await store.upsertMany([
      entry(),
      entry({ id: "ctx-gradient", title: "渐变", semanticKey: "ui.design.gradient", content: "只用设计系统渐变。" }),
      entry({ id: "ctx-radius", title: "圆角", semanticKey: "ui.design.radius", content: "遵循圆角刻度。" }),
    ]);

    expect(await readdir(join(root, "user"))).toEqual(["ui-design.md"]);
    const parsed = parseContextDocument(await readFile(join(root, "user", "ui-design.md"), "utf8"));
    expect(parsed.segments.filter(({ type }) => type === "entry")).toHaveLength(3);
  });

  it("lists only active entries by default and keeps one active semantic key", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-store-"));
    const store = new MarkdownContextStore({ root, now: () => NOW });
    await store.upsertMany([
      entry(),
      entry({ id: "ctx-new-color", content: "使用中性色板。", updatedAt: NOW + 1 }),
      entry({ id: "ctx-candidate", semanticKey: "ui.design.shadow", status: "candidate" }),
      entry({ id: "ctx-disabled", semanticKey: "ui.design.radius", status: "disabled" }),
    ]);

    const active = await store.list({ scope: "user", scopeKey: "local-user" });

    expect(active.map(({ id }) => id)).toEqual(["ctx-new-color"]);
  });

  it("updates and forgets only the target block while preserving human text", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-store-"));
    const store = new MarkdownContextStore({ root, now: () => NOW });
    await store.upsertMany([entry(), entry({ id: "ctx-radius", semanticKey: "ui.design.radius", title: "圆角" })]);
    const path = join(root, "user", "ui-design.md");
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("---\n<!-- context-entry", "---\n\n人工说明：项目设计系统优先。\n\n<!-- context-entry"), "utf8");

    await store.update(entry({ content: "优先使用项目色板。", updatedAt: NOW + 1 }));
    await store.forget({ scope: "user", scopeKey: "local-user", id: "ctx-radius" });

    const content = await readFile(path, "utf8");
    expect(content).toContain("人工说明：项目设计系统优先。");
    expect(content).toContain("优先使用项目色板。");
    expect(content).not.toContain("ctx-radius");
  });

  it("reports a malformed managed document without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-store-"));
    const store = new MarkdownContextStore({ root, now: () => NOW });
    await store.upsertMany([entry()]);
    const path = join(root, "user", "ui-design.md");
    await writeFile(path, "---\nschema_version: 2\n---\n<!-- context-entry\nunclosed", "utf8");

    await expect(store.upsertMany([entry({ id: "ctx-radius", semanticKey: "ui.design.radius" })]))
      .rejects.toThrow(/invalid managed context document/i);
    expect(await readFile(path, "utf8")).toContain("unclosed");
  });

  it("serializes concurrent mutations for the same scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-store-"));
    const store = new MarkdownContextStore({ root, now: () => NOW });

    await Promise.all([
      store.upsertMany([entry()]),
      store.upsertMany([entry({ id: "ctx-radius", semanticKey: "ui.design.radius", title: "圆角" })]),
    ]);

    const entries = await store.list({ scope: "user", scopeKey: "local-user" });
    expect(entries.map(({ id }) => id).sort()).toEqual(["ctx-color", "ctx-radius"]);
  });

  it("removes expired candidates but keeps recent candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-store-"));
    const store = new MarkdownContextStore({ root, now: () => NOW, candidateRetentionDays: 30 });
    await store.upsertMany([
      entry({ id: "ctx-old", topic: "pending", status: "candidate", semanticKey: "old", updatedAt: NOW - 31 * 86_400_000 }),
      entry({ id: "ctx-recent", topic: "pending", status: "candidate", semanticKey: "recent", updatedAt: NOW - 2 * 86_400_000 }),
    ]);

    expect(await store.cleanupExpiredCandidates()).toBe(1);
    const candidates = await store.list({ scope: "user", scopeKey: "local-user", status: "candidate" });
    expect(candidates.map(({ id }) => id)).toEqual(["ctx-recent"]);
  });
});
