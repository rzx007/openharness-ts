import { describe, expect, it, vi } from "vitest";

import type { ContextEntryRecord } from "@openharness/context";

import { ContextConsolidationService } from "../context-consolidation-service.js";

function entry(id: string, topic: ContextEntryRecord["topic"]): ContextEntryRecord {
  return {
    id, topic, title: id, scope: "project", scopeKey: "project-1", kind: "project_rule",
    semanticKey: `rule.${id}`, content: `content ${id}`, normalizedContent: `content ${id}`,
    status: "active", sensitivity: "none", confidence: 1, importance: 0.7,
    origin: "context_api", useCount: 0, createdAt: 1, updatedAt: 1,
  };
}

describe("ContextConsolidationService", () => {
  it("returns a structured preview without writing or backing up", async () => {
    const store = { list: vi.fn(async () => [entry("ctx-a", "rules"), entry("ctx-b", "rules")]), update: vi.fn(), forget: vi.fn(), upsertMany: vi.fn() };
    const backup = { create: vi.fn() };
    const service = new ContextConsolidationService({
      store,
      backup,
      planner: { plan: vi.fn(async () => [{ type: "merge", sourceIds: ["ctx-a", "ctx-b"], content: "统一后的项目规则" }]) },
    });

    const result = await service.consolidate({ scope: "project", scopeKey: "project-1", preview: true });

    expect(result.operations).toEqual([{ type: "merge", sourceIds: ["ctx-a", "ctx-b"], content: "统一后的项目规则" }]);
    expect(store.update).not.toHaveBeenCalled();
    expect(backup.create).not.toHaveBeenCalled();
  });

  it("rejects path-bearing output and unknown entry ids before writes", async () => {
    const store = { list: vi.fn(async () => [entry("ctx-a", "rules")]), update: vi.fn(), forget: vi.fn(), upsertMany: vi.fn() };
    for (const operation of [
      { type: "update", id: "ctx-a", content: "x", path: "C:\\context\\rules.md" },
      { type: "disable", id: "ctx-missing" },
    ]) {
      const service = new ContextConsolidationService({
        store,
        backup: { create: vi.fn() },
        planner: { plan: vi.fn(async () => [operation]) },
      });
      await expect(service.consolidate({ scope: "project", scopeKey: "project-1" })).rejects.toThrow();
    }
    expect(store.update).not.toHaveBeenCalled();
  });

  it("backs up affected topics and applies merge through logical entries", async () => {
    const entries = [entry("ctx-a", "rules"), entry("ctx-b", "knowledge")];
    const store = { list: vi.fn(async () => entries), update: vi.fn(), forget: vi.fn(async () => true), upsertMany: vi.fn() };
    const backup = { create: vi.fn(async () => ({ id: "backup-1", documents: [] })) };
    const service = new ContextConsolidationService({
      store,
      backup,
      now: () => 10,
      planner: { plan: vi.fn(async () => [{ type: "merge", sourceIds: ["ctx-a", "ctx-b"], content: "统一规则" }]) },
    });

    const result = await service.consolidate({ scope: "project", scopeKey: "project-1" });

    expect(result.backupId).toBe("backup-1");
    expect(backup.create).toHaveBeenCalledWith(expect.arrayContaining([
      { scope: "project", scopeKey: "project-1", topic: "rules" },
      { scope: "project", scopeKey: "project-1", topic: "knowledge" },
    ]));
    expect(store.upsertMany).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([{ index: 0, status: "applied" }]);
  });
});
