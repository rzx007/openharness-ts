import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextEntryRecord } from "@openharness/context";
import { MarkdownContextStore } from "@openharness/services/context";
import { describe, expect, it } from "vitest";

import { ContextIntentResolver } from "../context-intent-resolver.js";
import { ContextPersistenceService } from "../context-persistence-service.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openharness-context-persistence-"));
  const store = new MarkdownContextStore({ root, now: () => 1_788_166_800_000 });
  return {
    store,
    service: new ContextPersistenceService({
      store,
      resolver: new ContextIntentResolver(),
      now: () => 1_788_166_800_000,
    }),
  };
}

const projectScope = { userScopeKey: "local-user", projectId: "project-1", machineId: "machine-1" };

describe("ContextPersistenceService", () => {
  it("commits explicit global preferences and project rules", async () => {
    const { service } = await fixture();

    await expect(service.remember({ content: "请全局记住，以后回答尽量简洁", runtimeScope: projectScope }))
      .resolves.toMatchObject({ status: "completed", results: [{ status: "committed", entry: { scope: "user" } }] });
    await expect(service.remember({ content: "记住这个项目统一使用 pnpm", runtimeScope: projectScope }))
      .resolves.toMatchObject({
        status: "completed",
        results: [{ status: "committed", entry: { kind: "project_rule", scope: "project", scopeKey: "project-1" } }],
      });
  });

  it("asks for clarification when project scope is missing or content is sensitive", async () => {
    const { service } = await fixture();

    await expect(service.remember({
      content: "记住这个项目统一使用 pnpm",
      runtimeScope: { userScopeKey: "local-user" },
    })).resolves.toMatchObject({ results: [{ status: "clarification", reason: "scope_unresolved" }] });
    await expect(service.remember({
      content: "记住内部服务地址是 192.168.1.20",
      runtimeScope: projectScope,
    })).resolves.toMatchObject({ results: [{ status: "clarification", reason: "sensitive" }] });
  });

  it("rejects secrets without persisting them", async () => {
    const { service, store } = await fixture();

    const result = await service.remember({ content: "记住 API key 是 sk-test-secret", runtimeScope: projectScope });

    expect(result).toMatchObject({ results: [{ status: "rejected", reason: "secret" }] });
    expect(await store.list({ scope: "user", scopeKey: "local-user" })).toEqual([]);
  });

  it("returns noop for equivalent content and conflict for a changed semantic slot", async () => {
    const { service } = await fixture();
    await service.remember({ content: "记住这个项目统一使用 npm", runtimeScope: projectScope });

    await expect(service.remember({ content: "记住这个项目统一使用 NPM。", runtimeScope: projectScope }))
      .resolves.toMatchObject({ results: [{ status: "noop" }] });
    await expect(service.remember({ content: "记住这个项目统一使用 pnpm", runtimeScope: projectScope }))
      .resolves.toMatchObject({ results: [{ status: "clarification", reason: "conflict" }] });
  });

  it("atomically replaces an existing semantic entry when explicitly requested", async () => {
    const { service, store } = await fixture();
    await service.remember({ content: "记住这个项目统一使用 npm", runtimeScope: projectScope });

    const result = await service.remember({ content: "把这个项目的包管理器改成 pnpm", runtimeScope: projectScope });
    const active = await store.list({ scope: "project", scopeKey: "project-1" });

    expect(result).toMatchObject({ results: [{ status: "committed" }] });
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toContain("pnpm");
  });

  it("returns independent results when one request contains several preferences", async () => {
    const { service } = await fixture();
    const result = await service.remember({
      content: "记住：回答详细一点；代码注释用中文；当前项目提交前必须运行测试",
      runtimeScope: projectScope,
    });

    expect(result.results).toMatchObject([
      { status: "committed", entry: { semanticKey: "response.verbosity", scope: "user" } },
      { status: "committed", entry: { semanticKey: "code.comment_language", scope: "user" } },
      { status: "committed", entry: { semanticKey: "git.pre_commit_test", scope: "project" } },
    ]);
  });

  it("owns scoped recall, update, and forget instead of exposing store operations to adapters", async () => {
    const { service, store } = await fixture();
    await service.remember({ content: "记住这个项目统一使用 npm", runtimeScope: projectScope });
    const [created] = await store.list({ scope: "project", scopeKey: "project-1" });

    await expect(service.recall({ runtimeScope: projectScope, query: "包管理器" })).resolves.toEqual({
      status: "completed",
      entries: [{
        id: created!.id,
        title: "项目包管理器",
        scope: "project",
        kind: "project_rule",
        semanticKey: "node.package_manager",
        content: "当前项目使用 npm。",
        updatedAt: 1_788_166_800_000,
      }],
    });
    await expect(service.recall({
      runtimeScope: { ...projectScope, projectId: "project-2" },
      query: "包管理器",
    })).resolves.toEqual({ status: "completed", entries: [] });

    await expect(service.update({
      runtimeScope: projectScope,
      id: created!.id,
      content: "API key 是 sk-test-secret",
    })).resolves.toEqual({ status: "rejected", reason: "secret", id: created!.id });
    await expect(service.update({
      runtimeScope: projectScope,
      id: created!.id,
      content: "当前项目使用 pnpm。",
    })).resolves.toMatchObject({ status: "committed", entry: { id: created!.id, content: "当前项目使用 pnpm。" } });

    await expect(service.forget({ runtimeScope: projectScope, id: created!.id }))
      .resolves.toEqual({ status: "forgotten", id: created!.id });
    await expect(service.get({ runtimeScope: projectScope, id: created!.id })).resolves.toBeUndefined();
  });

  it("owns candidate acceptance and rejection within the resolved runtime scope", async () => {
    const { service, store } = await fixture();
    await store.upsertMany([
      candidate("ctx-accept", "project-1", "候选 API 地址"),
      candidate("ctx-reject", "project-1", "候选架构说明"),
      candidate("ctx-other", "project-2", "其他项目候选"),
      { ...candidate("ctx-history", "project-1", "历史条目"), status: "superseded", topic: "knowledge" },
    ]);

    for (const id of ["ctx-accept", "ctx-history"]) {
      await expect(service.get({ runtimeScope: projectScope, id })).resolves.toBeUndefined();
      await expect(service.update({ runtimeScope: projectScope, id, content: "不能直接修改。" }))
        .resolves.toEqual({ status: "not_found", id });
      await expect(service.forget({ runtimeScope: projectScope, id }))
        .resolves.toEqual({ status: "not_found", id });
    }
    await expect(store.get({ scope: "project", scopeKey: "project-1", id: "ctx-accept" }))
      .resolves.toMatchObject({ status: "candidate" });
    await expect(store.get({ scope: "project", scopeKey: "project-1", id: "ctx-history" }))
      .resolves.toMatchObject({ status: "superseded" });

    await expect(service.resolve({
      runtimeScope: projectScope,
      id: "ctx-accept",
      action: "accept",
      topic: "knowledge",
    })).resolves.toMatchObject({ status: "committed", entry: { id: "ctx-accept", status: "active", topic: "knowledge" } });
    await expect(service.resolve({ runtimeScope: projectScope, id: "ctx-reject", action: "reject" }))
      .resolves.toEqual({ status: "rejected", id: "ctx-reject" });
    await expect(service.resolve({ runtimeScope: projectScope, id: "ctx-other", action: "accept" }))
      .resolves.toEqual({ status: "not_found", id: "ctx-other" });
  });
});

function candidate(id: string, scopeKey: string, title: string): ContextEntryRecord {
  return {
    id,
    title,
    scope: "project",
    scopeKey,
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
