import { Check, LoaderCircle, TriangleAlert } from "lucide-react"

export type ContextCompactionPhase = "started" | "completed" | "failed"

export interface ContextCompactionPresentation {
  kind: "context_compaction"
  phase: ContextCompactionPhase
}

export function readContextCompactionPresentation(
  metadata: Record<string, unknown>,
): ContextCompactionPresentation | null {
  const presentation = metadata.presentation
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null
  const value = presentation as Record<string, unknown>
  if (value.kind !== "context_compaction") return null
  if (value.phase !== "started" && value.phase !== "completed" && value.phase !== "failed") return null
  return { kind: "context_compaction", phase: value.phase }
}

export function ContextCompactionDivider({ presentation }: { presentation: ContextCompactionPresentation }) {
  const label = presentation.phase === "started"
    ? "正在压缩上下文"
    : presentation.phase === "completed"
      ? "已压缩上下文"
      : "上下文压缩失败"
  const Icon = presentation.phase === "started" ? LoaderCircle : presentation.phase === "completed" ? Check : TriangleAlert
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-2 py-2 text-xs text-ui-muted">
      <span className="h-px flex-1 bg-border/60" />
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Icon className={presentation.phase === "started" ? "size-3.5 animate-spin" : "size-3.5"} />
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  )
}
