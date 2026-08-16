import { AlertCircle, X } from "lucide-react"

export function ErrorBanner({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-destructive/15 bg-destructive/6 px-4 py-2.5 text-xs text-destructive"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 leading-5 break-words whitespace-pre-wrap">{message}</span>
      <button
        type="button"
        aria-label="关闭错误提示"
        onClick={onClose}
        className="grid size-6 place-items-center rounded-md hover:bg-destructive/10 [&_svg]:size-3.5"
      >
        <X />
      </button>
    </div>
  )
}
