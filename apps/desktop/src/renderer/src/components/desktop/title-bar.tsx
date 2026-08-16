import { ArrowLeft, ArrowRight, Minus, PanelLeft, Square, X } from "lucide-react"

import { cn } from "@renderer/lib/utils"

type TitleBarProps = {
  sidebarOpen: boolean
  isMaximized: boolean
  onToggleSidebar: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

const menuItems = ["文件", "编辑", "视图", "帮助"]

export function TitleBar({
  sidebarOpen,
  isMaximized,
  onToggleSidebar,
  onMinimize,
  onToggleMaximize,
  onClose,
}: TitleBarProps): React.JSX.Element {
  return (
    <header className="titlebar-drag flex h-9 shrink-0 items-center bg-transparent text-ui-foreground select-none">
      <div className="titlebar-no-drag flex h-full items-center gap-0.5 px-2">
        <ToolbarButton
          label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelLeft className="size-3.6!" />
        </ToolbarButton>
        <ToolbarButton label="后退" disabled>
          <ArrowLeft />
        </ToolbarButton>
        <ToolbarButton label="前进" disabled>
          <ArrowRight />
        </ToolbarButton>
      </div>

      <nav className="titlebar-no-drag ml-1 flex h-full items-center" aria-label="应用菜单">
        {menuItems.map((item) => (
          <button
            key={item}
            type="button"
            className="h-7 rounded px-2.5 text-[13px] text-ui-muted/70 transition-colors hover:bg-black/5 hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            {item}
          </button>
        ))}
      </nav>

      <div className="titlebar-no-drag ml-auto flex h-full items-stretch">
        <WindowButton label="最小化" onClick={onMinimize}>
          <Minus />
        </WindowButton>
        <WindowButton label={isMaximized ? "还原" : "最大化"} onClick={onToggleMaximize}>
          {isMaximized ? <CopySquareIcon /> : <Square />}
        </WindowButton>
        <WindowButton label="关闭" danger onClick={onClose}>
          <X />
        </WindowButton>
      </div>
    </header>
  )
}

function ToolbarButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded text-ui-muted transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&_svg]:size-4",
        "hover:bg-black/5 hover:text-ui-foreground active:bg-black/8",
        "disabled:pointer-events-none disabled:opacity-35",
        pressed && "bg-black/5 text-ui-foreground"
      )}
    >
      {children}
    </button>
  )
}

function WindowButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid h-full w-12 place-items-center text-ui-foreground transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset [&_svg]:size-3.5",
        danger
          ? "hover:bg-red-600 hover:text-white active:bg-red-700"
          : "hover:bg-black/7 active:bg-black/10"
      )}
    >
      {children}
    </button>
  )
}

function CopySquareIcon(): React.JSX.Element {
  return (
    <span className="relative block size-3.5" aria-hidden="true">
      <span className="absolute top-0 right-0 size-2.5 border border-current" />
      <span className="absolute bottom-0 left-0 size-2.5 border border-current bg-shell" />
    </span>
  )
}
