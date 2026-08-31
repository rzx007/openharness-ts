import { normalizeContextContent, routeContextTopic, type ContextEntryRecord, type ContextEntryStatus, type ContextKind, type ContextScope, type ContextTopic } from "@openharness/context";
import type { MarkdownContextStore } from "@openharness/services/context";

import type { ContextPersistenceService } from "./context-persistence-service.js";
import type { ContextQueryService } from "./context-query-service.js";
import { detectContextSensitivity } from "./context-sensitive-data.js";
import { ContextResourceError } from "./context-resource-error.js";

export { ContextResourceError } from "./context-resource-error.js";

export class ContextResourceService {
  constructor(private readonly options: {
    store: MarkdownContextStore;
    sessions: { inspectProject(cwd: string): { id: string } };
    persistence: ContextPersistenceService;
    query: ContextQueryService;
    now?: () => number;
  }) {}

  async list(input: { cwd: string; scope?: ContextScope; kind?: ContextKind; status?: ContextEntryStatus }) {
    const refs = await this.refs(input.cwd, input.scope);
    const rows = (await Promise.all(refs.map((ref) => this.options.store.list({ ...ref, status: input.status })))).flat();
    return rows.filter((entry) => !input.kind || entry.kind === input.kind);
  }

  async get(input: { cwd: string; id: string }): Promise<ContextEntryRecord> {
    const located = await this.locate(input.cwd, input.id);
    if (!located) throw new ContextResourceError("not_found", `Context entry not found: ${input.id}`);
    return located.entry;
  }

  async add(input: { cwd: string; content: string }) {
    const runtimeScope = await this.runtimeScope(input.cwd);
    const result = await this.options.persistence.remember({ content: input.content, runtimeScope });
    const reason = result.results.find((item) => item.status === "rejected" || item.status === "clarification");
    if (reason?.status === "rejected" && reason.reason === "secret") throw new ContextResourceError("secret", "Secret context cannot be stored");
    if (reason?.status === "clarification" && reason.reason === "sensitive") throw new ContextResourceError("sensitive", "Sensitive context requires confirmation");
    return result;
  }

  async update(input: { cwd: string; id: string; content: string; title?: string }) {
    const current = await this.get(input);
    const sensitivity = detectContextSensitivity(input.content);
    if (sensitivity === "secret") throw new ContextResourceError("secret", "Secret context cannot be stored");
    if (sensitivity === "sensitive") throw new ContextResourceError("sensitive", "Sensitive context requires confirmation");
    const entry = { ...current, ...(input.title?.trim() ? { title: input.title.trim() } : {}), content: input.content.trim(), normalizedContent: normalizeContextContent(input.content), updatedAt: (this.options.now ?? Date.now)() };
    await this.options.store.update(entry);
    return entry;
  }

  async remove(input: { cwd: string; id: string }): Promise<void> {
    const located = await this.locate(input.cwd, input.id);
    if (!located) throw new ContextResourceError("not_found", `Context entry not found: ${input.id}`);
    await this.options.store.forget({ ...located.ref, id: input.id });
  }

  async candidates(cwd: string) {
    return await this.list({ cwd, status: "candidate" });
  }

  async accept(input: { cwd: string; id: string; topic?: ContextTopic }) {
    const located = await this.locate(input.cwd, input.id, "candidate");
    if (!located) throw new ContextResourceError("not_found", `Context candidate not found: ${input.id}`);
    const topic = input.topic ?? routeContextTopic({ ...located.entry, evidence: located.entry.content, replace: false });
    return await this.options.store.acceptCandidate({ ...located.ref, id: input.id, topic });
  }

  async reject(input: { cwd: string; id: string }): Promise<void> {
    const located = await this.locate(input.cwd, input.id, "candidate");
    if (!located) throw new ContextResourceError("not_found", `Context candidate not found: ${input.id}`);
    await this.options.store.forget({ ...located.ref, id: input.id });
  }

  async status(cwd: string) {
    const active = await this.list({ cwd });
    const candidates = await this.candidates(cwd);
    return {
      enabled: true,
      active: active.length,
      candidates: candidates.length,
      byScope: countBy(active, ({ scope }) => scope),
      byKind: countBy(active, ({ kind }) => kind),
    };
  }

  async preview(cwd: string, userInput = "") {
    return { content: await this.options.query.retrieve(userInput, await this.runtimeScope(cwd)) };
  }

  private async runtimeScope(cwd: string) {
    return {
      userScopeKey: "local-user" as const,
      machineId: await this.options.store.paths.getOrCreateMachineId(),
      projectId: this.options.sessions.inspectProject(cwd).id,
    };
  }

  private async refs(cwd: string, scope?: ContextScope) {
    const runtime = await this.runtimeScope(cwd);
    const refs = [
      { scope: "user" as const, scopeKey: runtime.userScopeKey },
      { scope: "machine" as const, scopeKey: runtime.machineId },
      { scope: "project" as const, scopeKey: runtime.projectId },
    ];
    return scope ? refs.filter((ref) => ref.scope === scope) : refs;
  }

  private async locate(cwd: string, id: string, status?: ContextEntryStatus) {
    for (const ref of await this.refs(cwd)) {
      const entry = (await this.options.store.list({ ...ref, status })).find((candidate) => candidate.id === id);
      if (entry) return { ref, entry };
    }
    return undefined;
  }
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}
