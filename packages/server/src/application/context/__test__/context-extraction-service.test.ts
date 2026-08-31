import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextProposal } from "@openharness/context";
import { MarkdownContextStore } from "@openharness/services/context";
import { describe, expect, it } from "vitest";

import { ContextExtractionService } from "../context-extraction-service.js";

async function fixture(extract: () => ContextProposal[]) {
  const root = await mkdtemp(join(tmpdir(), "openharness-context-extract-"));
  const store = new MarkdownContextStore({ root, now: () => 1_788_166_800_000 });
  const service = new ContextExtractionService({ store, extractor: { extract } });
  return { store, service };
}

function proposal(overrides: Partial<ContextProposal> = {}): ContextProposal {
  return {
    title: "服务地址",
    content: "项目 API 是 https://api.example.com。",
    kind: "environment_fact",
    scope: "project",
    scopeKey: "project-1",
    semanticKey: "environment.endpoint.api",
    confidence: 0.96,
    sensitivity: "none",
    evidence: "https://api.example.com",
    replace: false,
    ...overrides,
  };
}

describe("ContextExtractionService", () => {
  it("auto-commits only a high-confidence safe environment fact", async () => {
    const { store, service } = await fixture(() => [proposal()]);
    await service.extract({ messages: [], runtimeScope: { userScopeKey: "local-user", projectId: "project-1", machineId: "machine-1" } });
    expect(await store.list({ scope: "project", scopeKey: "project-1" })).toMatchObject([
      { topic: "environment", status: "active" },
    ]);
  });

  it("routes lower-confidence, knowledge, and sensitive proposals into one pending document", async () => {
    const { store, service } = await fixture(() => [
      proposal({ semanticKey: "endpoint.low", confidence: 0.9 }),
      proposal({ semanticKey: "knowledge.architecture", kind: "project_knowledge", confidence: 0.99 }),
      proposal({ semanticKey: "endpoint.internal", content: "内部地址 10.0.0.9", sensitivity: "sensitive" }),
    ]);
    await service.extract({ messages: [], runtimeScope: { userScopeKey: "local-user", projectId: "project-1", machineId: "machine-1" } });
    const pending = await store.list({ scope: "project", scopeKey: "project-1", status: "candidate" });
    expect(pending).toHaveLength(3);
    expect(new Set(pending.map(({ topic }) => topic))).toEqual(new Set(["pending"]));
  });

  it("drops secrets instead of creating a candidate", async () => {
    const { store, service } = await fixture(() => [proposal({ sensitivity: "secret", content: "sk-test-secret" })]);
    const result = await service.extract({ messages: [], runtimeScope: { userScopeKey: "local-user", projectId: "project-1" } });
    expect(result).toEqual({ committed: 0, candidates: 0, rejected: 1 });
    expect(await store.list({ scope: "project", scopeKey: "project-1", status: "candidate" })).toEqual([]);
  });
});
