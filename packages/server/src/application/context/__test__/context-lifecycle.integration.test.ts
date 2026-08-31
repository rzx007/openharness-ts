import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listDocumentEntries,
  parseContextDocument,
  type ContextProposal,
} from "@openharness/context";
import {
  getSessionMemoryContent,
  sessionMemoryToCompactText,
  updateSessionMemoryFile,
} from "@openharness/services";
import {
  ContextBackupService,
  MarkdownContextStore,
} from "@openharness/services/context";
import { describe, expect, it } from "vitest";

import { ContextConsolidationService } from "../context-consolidation-service.js";
import { ContextExtractionService } from "../context-extraction-service.js";
import { ContextIntentResolver } from "../context-intent-resolver.js";
import { ContextPersistenceService } from "../context-persistence-service.js";
import { ContextQueryService } from "../context-query-service.js";
import { ContextResourceService } from "../context-resource-service.js";

const runtimeScope = {
  userScopeKey: "local-user" as const,
  machineId: "machine-1",
  projectId: "project-1",
};

describe("Context persistence lifecycle", () => {
  it("governs remember, recall, conflict, candidates, consolidation, and forget as logical entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-context-lifecycle-"));
    try {
      let sequence = 0;
      const store = new MarkdownContextStore({ root, now: () => 1_788_166_800_000 + sequence });
      const persistence = new ContextPersistenceService({
        store,
        resolver: new ContextIntentResolver(),
        now: () => 1_788_166_800_000 + sequence,
        createId: () => `ctx-${++sequence}`,
      });
      const query = new ContextQueryService({ store });
      const resource = new ContextResourceService({
        sessions: { inspectProject: () => ({ id: runtimeScope.projectId }) },
        persistence,
        query,
        getMachineId: () => Promise.resolve(runtimeScope.machineId),
      });

      const ui = await persistence.remember({
        content: "请全局记住：UI 不使用紫色；UI 只使用设计系统规定的圆角；UI 避免重度阴影",
        runtimeScope,
      });
      expect(ui.results).toHaveLength(3);
      expect(ui.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "committed", entry: expect.objectContaining({ topic: "ui-design" }) }),
      ]));

      const uiDocument = parseContextDocument(await readFile(store.paths.documentFor({
        scope: "user",
        scopeKey: "local-user",
        topic: "ui-design",
      }), "utf8"));
      expect(uiDocument.schemaVersion).toBe(2);
      expect(listDocumentEntries(uiDocument)).toHaveLength(3);

      await persistence.remember({ content: "记住这个项目统一使用 npm", runtimeScope });
      const firstRecall = await query.retrieve("实现设置页面", runtimeScope);
      expect(firstRecall).toContain("UI 不使用紫色");
      expect(firstRecall).toContain("当前项目使用 npm");

      await expect(persistence.remember({
        content: "记住这个项目统一使用 pnpm",
        runtimeScope,
      })).resolves.toMatchObject({
        results: [{ status: "clarification", reason: "conflict" }],
      });
      await persistence.remember({ content: "把这个项目的包管理器改成 pnpm", runtimeScope });
      const rules = await store.list({ scope: "project", scopeKey: runtimeScope.projectId });
      expect(rules.filter(({ semanticKey }) => semanticKey === "node.package_manager"))
        .toMatchObject([{ content: "当前项目使用 pnpm。" }]);

      const mixed = await persistence.remember({
        content: "记住：回答尽量简洁；API key 是 sk-test-secret",
        runtimeScope,
      });
      expect(mixed.results.map(({ status }) => status)).toEqual(["committed", "rejected"]);
      expect(JSON.stringify(await resource.list({ cwd: root }))).not.toContain("sk-test-secret");

      const automaticProposals: ContextProposal[] = [
        proposal("candidate.endpoint", "候选 API 地址", "项目 API 是 https://api.example.com。"),
        proposal("candidate.knowledge", "候选架构说明", "网关负责统一鉴权。", {
          kind: "project_knowledge",
          confidence: 0.99,
        }),
      ];
      const extraction = new ContextExtractionService({
        store,
        extractor: { extract: () => automaticProposals },
        createId: () => `ctx-${++sequence}`,
      });
      await expect(extraction.extract({ messages: [], runtimeScope }))
        .resolves.toEqual({ committed: 0, candidates: 2, rejected: 0 });
      const candidates = await resource.candidates(root);
      expect(candidates).toHaveLength(2);
      expect(new Set(candidates.map(({ topic }) => topic))).toEqual(new Set(["pending"]));

      const accepted = await resource.accept({ cwd: root, id: candidates[0]!.id });
      expect(accepted.status).toBe("active");
      expect(await resource.candidates(root)).toHaveLength(1);

      let plannerInput: unknown;
      const consolidation = new ContextConsolidationService({
        store,
        backup: new ContextBackupService({ root }),
        planner: {
          plan: async (entries) => {
            plannerInput = entries;
            const target = entries.find(({ topic }) => topic === "ui-design")!;
            return [{ type: "update", id: target.id, content: `${target.content}（已整合）` }];
          },
        },
      });
      const preview = await consolidation.consolidate({
        scope: "user",
        scopeKey: "local-user",
        preview: true,
      });
      expect(JSON.stringify(plannerInput)).not.toMatch(/path|directory|root|file/iu);
      expect(preview).toMatchObject({ preview: true, results: [] });
      expect(await query.retrieve("设计设置页面", runtimeScope)).not.toContain("已整合");
      await consolidation.consolidate({ scope: "user", scopeKey: "local-user" });
      expect(await query.retrieve("设计设置页面", runtimeScope)).toContain("已整合");

      const packageRule = (await resource.list({ cwd: root, scope: "project" }))
        .find(({ semanticKey }) => semanticKey === "node.package_manager")!;
      await resource.remove({ cwd: root, id: packageRule.id });
      const finalRecall = await query.retrieve("安装依赖并调整 UI", runtimeScope);
      expect(finalRecall).not.toContain("当前项目使用 pnpm");
      expect(finalRecall).toContain("UI");
      expect(listDocumentEntries(parseContextDocument(await readFile(store.paths.documentFor({
        scope: "user",
        scopeKey: "local-user",
        topic: "ui-design",
      }), "utf8")))).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips the separate session continuity checkpoint into compact text", async () => {
    const root = await mkdtemp(join(tmpdir(), "openharness-session-continuity-"));
    const previous = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = join(root, "config");
    try {
      const checkpoint = updateSessionMemoryFile(root, [
        { role: "user", content: "继续实现 Context 生命周期测试" },
        { role: "assistant", content: "下一步运行完整验证" },
      ], { sessionId: "session-1" });
      const compactText = sessionMemoryToCompactText(getSessionMemoryContent(checkpoint));
      expect(compactText).toContain("Session memory checkpoint");
      expect(compactText).toContain("Context 生命周期测试");
      expect(compactText).toContain("下一步运行完整验证");
    } finally {
      if (previous === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

function proposal(
  semanticKey: string,
  title: string,
  content: string,
  overrides: Partial<ContextProposal> = {},
): ContextProposal {
  return {
    title,
    content,
    kind: "environment_fact",
    scope: "project",
    scopeKey: runtimeScope.projectId,
    semanticKey,
    confidence: 0.9,
    sensitivity: "none",
    evidence: content,
    replace: false,
    ...overrides,
  };
}
