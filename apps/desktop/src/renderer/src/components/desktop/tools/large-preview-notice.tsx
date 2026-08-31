import { AlertTriangle } from "lucide-react"

import { Button } from "@renderer/components/ui/button"

interface LargePreviewNoticeProps {
  title: string
  description: string
  primaryLabel?: string
  onPrimary?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}

export function LargePreviewNotice({
  title,
  description,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: LargePreviewNoticeProps): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-amber-500/20 bg-amber-500/8 px-3 py-2 text-[12px]"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{title}</div>
        <div className="truncate text-muted-foreground" title={description}>
          {description}
        </div>
      </div>
      {secondaryLabel && onSecondary ? (
        <Button type="button" size="xs" variant="ghost" onClick={onSecondary}>
          {secondaryLabel}
        </Button>
      ) : null}
      {primaryLabel && onPrimary ? (
        <Button type="button" size="xs" variant="outline" onClick={onPrimary}>
          {primaryLabel}
        </Button>
      ) : null}
    </div>
  )
}
