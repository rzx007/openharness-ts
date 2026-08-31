import type {
  ContextEntryRecord,
  ContextKind,
  ContextScope,
} from "@shared/context-types";

export type ContextPanelSection = "active" | "candidates" | "preview";
export type ContextEntryFilters = {
  scope: ContextScope | "all";
  kind: ContextKind | "all";
};

export const contextScopeLabels: Record<ContextScope, string> = {
  user: "用户",
  machine: "本机",
  project: "项目",
};

export const contextKindLabels: Record<ContextKind, string> = {
  user_preference: "用户偏好",
  project_rule: "项目规则",
  project_knowledge: "项目知识",
  environment_fact: "环境事实",
};

export function filterContextEntries(
  entries: readonly ContextEntryRecord[],
  filters: ContextEntryFilters,
): ContextEntryRecord[] {
  return entries
    .filter((entry) => filters.scope === "all" || entry.scope === filters.scope)
    .filter((entry) => filters.kind === "all" || entry.kind === filters.kind)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function describeContextSource(entry: ContextEntryRecord): string {
  const source = entry.sourceSessionId
    ? `会话 ${entry.sourceSessionId}`
    : "系统";
  return `${source} · ${formatContextTime(entry.updatedAt)}`;
}

export function formatContextTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
