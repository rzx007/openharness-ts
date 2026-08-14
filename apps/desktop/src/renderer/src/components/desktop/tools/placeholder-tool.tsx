import type { LucideIcon } from "lucide-react"
import type * as React from "react"

type PlaceholderToolProps = {
  icon: LucideIcon
  title: string
  description: string
  footer?: string
}

export function PlaceholderTool({
  icon: Icon,
  title,
  description,
  footer,
}: PlaceholderToolProps): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <Icon className="mb-4 size-9 text-ui-muted" strokeWidth={1.6} />
        <h2 className="text-[17px] font-semibold text-ui-foreground">{title}</h2>
        <p className="mt-2 max-w-72 text-[13px] leading-6 text-ui-muted">{description}</p>
      </div>
      {footer && (
        <div className="border-t bg-muted/35 px-4 py-3 font-mono text-[12px] text-ui-muted">
          {footer}
        </div>
      )}
    </section>
  )
}
