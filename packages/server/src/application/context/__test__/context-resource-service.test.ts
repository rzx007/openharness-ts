import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextEntryRecord } from "@openharness/context";
import { MarkdownContextStore } from "@openharness/services/context";
import { describe, expect, it } from "vitest";

import { ContextIntentResolver } from "../context-intent-resolver.js";
import { ContextPersistenceService } from "../context-persistence-service.js";
import { ContextQueryService } from "../context-query-service.js";
import { ContextResourceService } from "../context-resource-service.js";

describe("ContextResourceService", () => {
  it("manages entries through ContextPersistenceService without receiving the Markdown store", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-resource-"));
    const store = new MarkdownContextStore({ root, now: () => 1_788_166_800_000 });
    const persistence = new ContextPersistenceService({
      store,
      resolver: new ContextIntentResolver(),
      now: () => 1_788_166_900_000,
      createId: () => "ctx-rule",
    });
    const service = new ContextResourceService({
      sessions: { inspectProject: () => ({ id: "project-1" }) },
      persistence,
      query: new ContextQueryService({ store }),
      getMachineId: () => Promise.resolve("machine-1"),
    });

    await service.add({ cwd: root, content: "记住这个项目统一使用 npm" });
    await expect(service.list({ cwd: root, scope: "project" }))
      .resolves.toMatchObject([{ id: "ctx-rule", content: "当前项目使用 npm。" }]);
    await expect(service.update({ cwd: root, id: "ctx-rule", content: "当前项目使用 pnpm。" }))
      .resolves.toMatchObject({ id: "ctx-rule", content: "当前项目使用 pnpm。" });
    await service.remove({ cwd: root, id: "ctx-rule" });
    await expect(service.get({ cwd: root, id: "ctx-rule" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("accepts and rejects candidates through the same persistence service", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-resource-candidate-"));
    const store = new MarkdownContextStore({ root, now: () => 1_788_166_800_000 });
    const persistence = new ContextPersistenceService({ store, resolver: new ContextIntentResolver() });
    const service = new ContextResourceService({
      sessions: { inspectProject: () => ({ id: "project-1" }) },
      persistence,
      query: new ContextQueryService({ store }),
      getMachineId: () => Promise.resolve("machine-1"),
    });
    await store.upsertMany([
      candidate("ctx-accept", "接受候选"),
      candidate("ctx-reject", "拒绝候选"),
    ]);

    await expect(service.accept({ cwd: root, id: "ctx-accept", topic: "knowledge" }))
      .resolves.toMatchObject({ id: "ctx-accept", status: "active", topic: "knowledge" });
    await service.reject({ cwd: root, id: "ctx-reject" });
    await expect(service.candidates(root)).resolves.toEqual([]);
  });
});

function candidate(id: string, title: string): ContextEntryRecord {
  return {
    id,
    title,
    scope: "project",
    scopeKey: "project-1",
    kind: "project_knowledge",
    semanticKey: `candidate.${id}`,
    topic: "pending",
    content: `${title}。`,
    normalizedContent: `${title}。`,
    status: "candidate",
    sensitivity: "none",
    confidence: 0.8,
    importance: 0.8,
    origin: "automatic_extraction",
    useCount: 0,
    createdAt: 1_788_166_800_000,
    updatedAt: 1_788_166_800_000,
  };
}
