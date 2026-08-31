import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextEntryRecord } from "@openharness/context";
import { MarkdownContextStore } from "@openharness/services/context";
import { describe, expect, it } from "vitest";

import { ContextQueryService } from "../context-query-service.js";

function entry(overrides: Partial<ContextEntryRecord>): ContextEntryRecord {
  return {
    id: "ctx-default",
    title: "偏好",
    scope: "user",
    scopeKey: "local-user",
    kind: "user_preference",
    semanticKey: "node.package_manager",
    topic: "development-workflow",
    content: "用户通常偏好 npm。",
    normalizedContent: "用户通常偏好 npm",
    status: "active",
    sensitivity: "none",
    confidence: 1,
    importance: 0.8,
    origin: "explicit_user",
    useCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("ContextQueryService", () => {
  it("lets a project rule override the same user semantic key", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-query-"));
    const store = new MarkdownContextStore({ root });
    await store.upsertMany([
      entry({}),
      entry({ id: "ctx-project", scope: "project", scopeKey: "project-1", kind: "project_rule", topic: "rules", content: "当前项目必须使用 pnpm。" }),
    ]);
    const service = new ContextQueryService({ store });

    const prompt = await service.retrieve("安装依赖", { userScopeKey: "local-user", projectId: "project-1", machineId: "machine-1" });

    expect(prompt).toContain("当前项目必须使用 pnpm。");
    expect(prompt).not.toContain("用户通常偏好 npm。");
  });

  it("does not load facts from another project and filters project knowledge by input", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-query-"));
    const store = new MarkdownContextStore({ root });
    await store.upsertMany([
      entry({ id: "ctx-other", scope: "project", scopeKey: "project-2", kind: "environment_fact", topic: "environment", semanticKey: "endpoint", content: "另一个项目地址 example.invalid。" }),
      entry({ id: "ctx-db", scope: "project", scopeKey: "project-1", kind: "project_knowledge", topic: "knowledge", semanticKey: "database.migration", title: "数据库迁移", content: "迁移脚本在 migrations 目录。" }),
    ]);
    const service = new ContextQueryService({ store });

    const unrelated = await service.retrieve("修改按钮颜色", { userScopeKey: "local-user", projectId: "project-1", machineId: "machine-1" });
    const related = await service.retrieve("数据库迁移放在哪里", { userScopeKey: "local-user", projectId: "project-1", machineId: "machine-1" });

    expect(unrelated).not.toContain("迁移脚本");
    expect(related).toContain("迁移脚本在 migrations 目录。");
    expect(related).not.toContain("example.invalid");
  });

  it("keeps the final prompt within the configured budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-query-"));
    const store = new MarkdownContextStore({ root });
    await store.upsertMany(Array.from({ length: 50 }, (_, index) => entry({
      id: `ctx-${index}`,
      semanticKey: `preference.${index}`,
      content: "内容".repeat(500),
    })));
    const service = new ContextQueryService({ store, maxChars: 12_000, maxEntries: 40 });
    expect((await service.retrieve("任何问题", { userScopeKey: "local-user", machineId: "machine-1" })).length)
      .toBeLessThanOrEqual(12_000);
  });
});
