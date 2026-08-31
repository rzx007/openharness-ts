import { Check, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ContextEntryRecord,
  ContextKind,
  ContextScope,
  ContextStatus,
} from "@shared/context-types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/utils";
import {
  contextKindLabels,
  contextScopeLabels,
  describeContextSource,
  filterContextEntries,
  type ContextPanelSection,
} from "./context-panel-model";

type ContextPanelProps = { cwd: string | null };

const sections: Array<{ id: ContextPanelSection; label: string }> = [
  { id: "active", label: "已保存" },
  { id: "candidates", label: "待确认" },
  { id: "preview", label: "注入预览" },
];

export function ContextPanel({ cwd }: ContextPanelProps): React.JSX.Element {
  const [section, setSection] = useState<ContextPanelSection>("active");
  const [entries, setEntries] = useState<ContextEntryRecord[]>([]);
  const [candidates, setCandidates] = useState<ContextEntryRecord[]>([]);
  const [preview, setPreview] = useState("");
  const [status, setStatus] = useState<ContextStatus | null>(null);
  const [scope, setScope] = useState<ContextScope | "all">("all");
  const [kind, setKind] = useState<ContextKind | "all">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<ContextEntryRecord | null>(null);
  const [removing, setRemoving] = useState<ContextEntryRecord | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const [nextEntries, nextCandidates, nextPreview, nextStatus] =
        await Promise.all([
          window.desktop.context.list({ cwd }),
          window.desktop.context.candidates({ cwd }),
          window.desktop.context.preview({ cwd }),
          window.desktop.context.status({ cwd }),
        ]);
      setEntries(nextEntries);
      setCandidates(nextCandidates);
      setPreview(nextPreview);
      setStatus(nextStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载持久上下文。");
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => void reload(), [reload]);

  const visibleEntries = useMemo(
    () => filterContextEntries(entries, { scope, kind }),
    [entries, kind, scope],
  );

  const mutate = async (operation: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await operation();
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "操作失败，请稍后重试。",
      );
    }
  };

  if (!cwd) {
    return (
      <PanelNotice
        title="尚未选择工作目录"
        detail="打开一个项目或会话后即可管理持久上下文。"
      />
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label="持久上下文管理"
    >
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">持久上下文</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {status
              ? `${status.active} 条生效 · ${status.candidates} 条待确认`
              : "按逻辑条目管理"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void reload()}
          disabled={loading}
          aria-label="刷新持久上下文"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <div
        className="flex shrink-0 gap-1 border-b px-3 pt-2"
        role="tablist"
        aria-label="上下文视图"
      >
        {sections.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            onClick={() => setSection(item.id)}
            className="text-muted-foreground hover:text-foreground aria-selected:border-foreground aria-selected:text-foreground border-b-2 border-transparent px-2 py-2 text-xs transition-colors"
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive mx-3 mt-3 rounded-md border px-3 py-2 text-xs"
        >
          {error}
        </div>
      )}

      {section === "active" && (
        <ActiveEntries
          entries={visibleEntries}
          scope={scope}
          kind={kind}
          draft={draft}
          loading={loading}
          onScopeChange={setScope}
          onKindChange={setKind}
          onDraftChange={setDraft}
          onAdd={() =>
            void mutate(async () => {
              await window.desktop.context.add({ cwd, content: draft });
              setDraft("");
            })
          }
          onEdit={setEditing}
          onRemove={setRemoving}
        />
      )}
      {section === "candidates" && (
        <EntryList
          entries={candidates}
          empty="没有待确认条目。"
          actions={(entry) => (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void mutate(() =>
                    window.desktop.context.accept({ cwd, entryId: entry.id }),
                  )
                }
              >
                <Check />
                接受
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void mutate(() =>
                    window.desktop.context.reject({ cwd, entryId: entry.id }),
                  )
                }
              >
                <X />
                拒绝
              </Button>
            </>
          )}
        />
      )}
      {section === "preview" && (
        <ScrollArea className="min-h-0 flex-1">
          <pre className="text-foreground/85 p-4 text-xs leading-5 whitespace-pre-wrap">
            {preview || "当前没有可注入的持久上下文。"}
          </pre>
        </ScrollArea>
      )}

      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条上下文？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后，智能体之后的对话将不再读取“{removing?.title}”。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                removing &&
                void mutate(() =>
                  window.desktop.context.remove({ cwd, entryId: removing.id }),
                ).finally(() => setRemoving(null))
              }
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>编辑上下文</AlertDialogTitle>
            <AlertDialogDescription>
              只修改这一个逻辑条目，不影响同主题中的其他内容。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={editing?.content ?? ""}
            onChange={(event) =>
              setEditing((current) =>
                current ? { ...current, content: event.target.value } : null,
              )
            }
            aria-label="上下文内容"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                editing &&
                void mutate(() =>
                  window.desktop.context.update({
                    cwd,
                    entryId: editing.id,
                    title: editing.title,
                    content: editing.content,
                  }),
                ).finally(() => setEditing(null))
              }
            >
              保存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ActiveEntries(props: {
  entries: ContextEntryRecord[];
  scope: ContextScope | "all";
  kind: ContextKind | "all";
  draft: string;
  loading: boolean;
  onScopeChange: (value: ContextScope | "all") => void;
  onKindChange: (value: ContextKind | "all") => void;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onEdit: (entry: ContextEntryRecord) => void;
  onRemove: (entry: ContextEntryRecord) => void;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 gap-2 border-b p-3">
        <Textarea
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          placeholder="输入要记住的偏好、规则或知识…"
          aria-label="新增持久上下文"
          className="min-h-16 resize-y"
        />
        <div className="flex items-center gap-2">
          <FilterSelect
            label="作用域"
            value={props.scope}
            onChange={(value) =>
              props.onScopeChange(value as ContextScope | "all")
            }
            options={[
              ["all", "全部作用域"],
              ...Object.entries(contextScopeLabels),
            ]}
          />
          <FilterSelect
            label="类型"
            value={props.kind}
            onChange={(value) =>
              props.onKindChange(value as ContextKind | "all")
            }
            options={[
              ["all", "全部类型"],
              ...Object.entries(contextKindLabels),
            ]}
          />
          <Button
            size="sm"
            className="ml-auto"
            disabled={!props.draft.trim() || props.loading}
            onClick={props.onAdd}
          >
            <Plus />
            保存
          </Button>
        </div>
      </div>
      <EntryList
        entries={props.entries}
        empty="没有符合条件的已保存条目。"
        actions={(entry) => (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`编辑 ${entry.title}`}
              onClick={() => props.onEdit(entry)}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`删除 ${entry.title}`}
              onClick={() => props.onRemove(entry)}
            >
              <Trash2 />
            </Button>
          </>
        )}
      />
    </div>
  );
}

function EntryList({
  entries,
  empty,
  actions,
}: {
  entries: ContextEntryRecord[];
  empty: string;
  actions: (entry: ContextEntryRecord) => React.ReactNode;
}): React.JSX.Element {
  if (entries.length === 0) return <PanelNotice title={empty} />;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="divide-y">
        {entries.map((entry) => (
          <article key={entry.id} className="px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">{entry.title}</h3>
                <p className="text-foreground/80 mt-1 text-sm leading-5 whitespace-pre-wrap">
                  {entry.content}
                </p>
                <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="outline">
                    {contextScopeLabels[entry.scope]}
                  </Badge>
                  <Badge variant="secondary">
                    {contextKindLabels[entry.kind]}
                  </Badge>
                  <span>{describeContextSource(entry)}</span>
                  {entry.sensitivity !== "none" && (
                    <span>
                      · {entry.sensitivity === "secret" ? "机密" : "敏感"}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {actions(entry)}
              </div>
            </div>
          </article>
        ))}
      </div>
    </ScrollArea>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[][];
}): React.JSX.Element {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select
        className="bg-background text-foreground focus-visible:ring-ring h-8 rounded-md border px-2 text-xs outline-none focus-visible:ring-2"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function PanelNotice({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div>
        <p className="text-muted-foreground text-sm">{title}</p>
        {detail && (
          <p className="text-muted-foreground/75 mt-1 text-xs">{detail}</p>
        )}
      </div>
    </div>
  );
}
