import type { ContextEntryRecord, ContextEntryStatus, ContextKind, ContextScope, ContextTopic } from "@openharness/context";

import type { ContextPersistenceService } from "./context-persistence-service.js";
import type { ContextQueryService } from "./context-query-service.js";
import { ContextResourceError } from "./context-resource-error.js";

export { ContextResourceError } from "./context-resource-error.js";

export class ContextResourceService {
  constructor(private readonly options: {
    sessions: { inspectProject(cwd: string): { id: string } };
    persistence: ContextPersistenceService;
    query: ContextQueryService;
    getMachineId(): Promise<string>;
  }) {}

  async list(input: { cwd: string; scope?: ContextScope; kind?: ContextKind; status?: ContextEntryStatus }) {
    return await this.options.persistence.list({
      runtimeScope: await this.runtimeScope(input.cwd),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  async get(input: { cwd: string; id: string }): Promise<ContextEntryRecord> {
    const entry = await this.options.persistence.get({ runtimeScope: await this.runtimeScope(input.cwd), id: input.id });
    if (!entry) throw new ContextResourceError("not_found", `Context entry not found: ${input.id}`);
    return entry;
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
    const result = await this.options.persistence.update({
      runtimeScope: await this.runtimeScope(input.cwd),
      id: input.id,
      content: input.content,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
    if (result.status === "not_found") throw new ContextResourceError("not_found", `Context entry not found: ${input.id}`);
    if (result.status === "rejected") throw new ContextResourceError("secret", "Secret context cannot be stored");
    if (result.status === "clarification") throw new ContextResourceError("sensitive", "Sensitive context requires confirmation");
    return result.entry;
  }

  async remove(input: { cwd: string; id: string }): Promise<void> {
    const result = await this.options.persistence.forget({ runtimeScope: await this.runtimeScope(input.cwd), id: input.id });
    if (result.status === "not_found") throw new ContextResourceError("not_found", `Context entry not found: ${input.id}`);
  }

  async candidates(cwd: string) {
    return await this.list({ cwd, status: "candidate" });
  }

  async accept(input: { cwd: string; id: string; topic?: ContextTopic }) {
    const result = await this.options.persistence.resolve({
      runtimeScope: await this.runtimeScope(input.cwd),
      id: input.id,
      action: "accept",
      ...(input.topic ? { topic: input.topic } : {}),
    });
    if (result.status === "not_found") throw new ContextResourceError("not_found", `Context candidate not found: ${input.id}`);
    return result.entry;
  }

  async reject(input: { cwd: string; id: string }): Promise<void> {
    const result = await this.options.persistence.resolve({
      runtimeScope: await this.runtimeScope(input.cwd),
      id: input.id,
      action: "reject",
    });
    if (result.status === "not_found") throw new ContextResourceError("not_found", `Context candidate not found: ${input.id}`);
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
      machineId: await this.options.getMachineId(),
      projectId: this.options.sessions.inspectProject(cwd).id,
    };
  }
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}
