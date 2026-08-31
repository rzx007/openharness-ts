import { renderContextPrompt, type ContextEntryRecord } from "@openharness/context";
import type { MarkdownContextStore } from "@openharness/services/context";

import type { ContextRuntimeScope } from "./context-intent-resolver.js";

export interface ContextQueryServiceOptions {
  store: Pick<MarkdownContextStore, "list">;
  maxChars?: number;
  maxEntries?: number;
}

export class ContextQueryService {
  private readonly store: ContextQueryServiceOptions["store"];
  private readonly maxChars: number;
  private readonly maxEntries: number;

  constructor(options: ContextQueryServiceOptions) {
    this.store = options.store;
    this.maxChars = options.maxChars ?? 12_000;
    this.maxEntries = options.maxEntries ?? 40;
  }

  async retrieve(userInput: string, scope: ContextRuntimeScope): Promise<string> {
    const user = await this.store.list({ scope: "user", scopeKey: scope.userScopeKey });
    const machine = scope.machineId
      ? await this.store.list({ scope: "machine", scopeKey: scope.machineId })
      : [];
    const project = scope.projectId
      ? await this.store.list({ scope: "project", scopeKey: scope.projectId })
      : [];
    const selected = selectEntries(userInput, user, machine, project);
    return renderContextPrompt(selected, { maxChars: this.maxChars, maxEntries: this.maxEntries });
  }
}

function selectEntries(
  userInput: string,
  user: ContextEntryRecord[],
  machine: ContextEntryRecord[],
  project: ContextEntryRecord[],
): ContextEntryRecord[] {
  const bySemanticKey = new Map<string, ContextEntryRecord>();
  for (const entry of [...user, ...machine, ...project]) {
    if (entry.kind === "project_knowledge" && !isRelevant(entry, userInput)) continue;
    bySemanticKey.set(entry.semanticKey, entry);
  }
  return [...bySemanticKey.values()].sort((left, right) =>
    scopePriority(right.scope) - scopePriority(left.scope)
    || right.importance - left.importance
    || right.updatedAt - left.updatedAt,
  );
}

function isRelevant(entry: ContextEntryRecord, userInput: string): boolean {
  const query = userInput.toLocaleLowerCase("en-US");
  if (query.includes(entry.title.toLocaleLowerCase("en-US"))) return true;
  const terms = `${entry.semanticKey} ${entry.title} ${entry.content}`
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2);
  return terms.some((term) => query.includes(term));
}

function scopePriority(scope: ContextEntryRecord["scope"]): number {
  return scope === "project" ? 3 : scope === "machine" ? 2 : 1;
}
