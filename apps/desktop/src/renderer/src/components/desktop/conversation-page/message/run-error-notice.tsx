import { AlertCircle, ChevronRight } from "lucide-react"

const missingDetailGuidance = "暂时没有更多错误信息。"

export function RunErrorNotice({ error }: { error?: string }): React.JSX.Element {
  const detail = error?.trim()
  const guidance = detail ? runFailureGuidance(detail) : missingDetailGuidance
  const statusRow = (
    <>
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600/80 dark:text-amber-400/80" />
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="font-medium">这次请求没有完成</span>
          {detail ? <span className="text-ui-muted">详情</span> : null}
        </span>
        {guidance ? <span className="mt-1 block leading-5 text-ui-muted">{guidance}</span> : null}
      </span>
    </>
  )

  return (
    <section
      data-run-error-notice
      aria-label="请求未完成"
      className="max-w-xl text-xs text-foreground/80"
    >
      {detail ? (
        <details className="group">
          <summary
            data-run-error-status-row
            aria-live="polite"
            aria-atomic="true"
            className="flex w-fit cursor-pointer list-none items-start gap-2 rounded-md py-1.5 pr-1 select-none hover:text-foreground [&::-webkit-details-marker]:hidden"
          >
            {statusRow}
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-ui-muted transition-transform group-open:rotate-90" />
          </summary>
          <pre className="text-ui-caption mt-1 ml-6 max-h-40 overflow-auto rounded-lg bg-muted/40 px-3 py-2 leading-relaxed whitespace-pre-wrap text-ui-muted">
            {detail}
          </pre>
        </details>
      ) : (
        <div
          data-run-error-status-row
          aria-live="polite"
          aria-atomic="true"
          className="flex w-fit items-start gap-2 py-1.5"
        >
          {statusRow}
        </div>
      )}
    </section>
  )
}

function runFailureGuidance(error: string): string | null {
  if (
    error.includes("not supported when using Codex") ||
    error.includes("supported API model names")
  ) {
    return "当前模型与供应商不匹配，请在输入框右下角重新选择模型。"
  }
  return null
}
