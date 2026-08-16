import { Check, ChevronDown, ShieldCheck } from "lucide-react"
import { forwardRef } from "react"

import { cn } from "@renderer/lib/utils"
import type { DesktopPermissionMode } from "@shared/session-types"
import type { PermissionModeOption } from "./types"

export const permissionModeOptions: PermissionModeOption[] = [
  {
    value: "default",
    label: "手动批准",
    description: "写入、命令等敏感操作会请求确认。",
  },
  {
    value: "plan",
    label: "计划模式",
    description: "保持只读分析，适合先审方案。",
  },
  {
    value: "full_auto",
    label: "自动批准",
    description: "尽量自动放行工具操作。",
  },
]

export function PermissionModeMenu({
  selected,
  onSelect,
  className,
}: {
  selected: DesktopPermissionMode
  onSelect: (mode: DesktopPermissionMode) => void
  className?: string
}): React.JSX.Element {
  return (
    <div role="menu" className={cn("text-popover-foreground", className)}>
      {permissionModeOptions.map((mode) => (
        <button
          key={mode.value}
          type="button"
          role="menuitemradio"
          aria-checked={selected === mode.value}
          onClick={() => onSelect(mode.value)}
          className={cn(
            "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            selected === mode.value && "bg-muted"
          )}
        >
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ui-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-foreground">{mode.label}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-ui-muted">
              {mode.description}
            </span>
          </span>
          {selected === mode.value ? <Check className="mt-0.5 size-3.5 shrink-0" /> : null}
        </button>
      ))}
    </div>
  )
}

export const StartPickerButton = forwardRef<
  HTMLButtonElement,
  {
    label: string
    expanded: boolean
    children: React.ReactNode
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function StartPickerButton({ label, expanded, children, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={expanded}
      aria-haspopup="menu"
      className={cn(
        "flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-ui-foreground transition-colors hover:bg-background/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        expanded && "bg-background/85",
        className
      )}
      {...props}
    >
      {children}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown className="size-3 text-ui-muted" />
    </button>
  )
})

export function PickerMenuItem({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ui-muted",
        selected && "bg-muted"
      )}
    >
      {children}
      {selected ? <Check className="ml-auto size-3.5 text-foreground" /> : null}
    </button>
  )
}

export function HeaderIconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded-md text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5",
        pressed && "bg-muted text-foreground"
      )}
    >
      {children}
    </button>
  )
}

export function ComposerIconButton({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid size-8 place-items-center rounded-md text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
    >
      {children}
    </button>
  )
}
