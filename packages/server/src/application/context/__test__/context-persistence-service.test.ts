import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarkdownContextStore } from "@openharness/services/context";
import { describe, expect, it } from "vitest";

import { ContextIntentResolver } from "../context-intent-resolver.js";
import { ContextPersistenceService } from "../context-persistence-service.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openharness-context-persistence-"));
  const store = new MarkdownContextStore({ root, now: () => 1_788_166_800_000 });
  return {
    store,
    service: new ContextPersistenceService({ store, resolver: new ContextIntentResolver() }),
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
});
