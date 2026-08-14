import {
  FileText,
  Folder,
  Globe2,
  Maximize2,
  MessageCirclePlus,
  PanelRightClose,
  SquareTerminal,
} from "lucide-react"
import { useState } from "react"

import { cn } from "@renderer/lib/utils"

type UtilityPanelProps = {
  open: boolean
  onClose: () => void
}

const panelActions = [
  { icon: FileText, label: "审阅", shortcut: "Ctrl+Shift+G" },
  { icon: SquareTerminal, label: "终端", shortcut: "" },
  { icon: Globe2, label: "浏览器", shortcut: "Ctrl+T" },
  { icon: Folder, label: "文件", shortcut: "Ctrl+P" },
  { icon: MessageCirclePlus, label: "侧边聊天", shortcut: "Ctrl+Alt+S" },
]

export function UtilityPanel({ open, onClose }: UtilityPanelProps): React.JSX.Element {
  const [activeAction, setActiveAction] = useState<string | null>(null)

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full min-h-0 w-full overflow-hidden bg-panel transition-opacity duration-150 ease-out",
        open ? "border-l opacity-100" : "pointer-events-none opacity-0"
      )}
    >
      <div className="flex h-full min-w-[320px] flex-col">
        <header className="flex h-12 shrink-0 items-center justify-end gap-1 border-b px-3">
          <PanelIconButton label="展开面板">
            <Maximize2 />
          </PanelIconButton>
          <PanelIconButton label="关闭面板" onClick={onClose}>
            <PanelRightClose />
          </PanelIconButton>
        </header>

        <div className="flex min-h-0 flex-1 flex-col justify-center px-8 pb-16">
          <nav className="mx-auto w-full max-w-[520px]" aria-label="工具面板">
            {panelActions.map(({ icon: Icon, label, shortcut }) => (
              <button
                key={label}
                type="button"
                aria-pressed={activeAction === label}
                onClick={() => setActiveAction((current) => (current === label ? null : label))}
                className={cn(
                  "flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] text-ui-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  activeAction === label && "bg-muted"
                )}
              >
                <Icon className="size-4 text-ui-muted" strokeWidth={1.8} />
                <span>{label}</span>
                {shortcut && (
                  <kbd className="ml-auto rounded bg-code px-1.5 py-0.5 font-sans text-[10px] text-ui-muted">
                    {shortcut}
                  </kbd>
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>
    </aside>
  )
}

function PanelIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
    >
      {children}
    </button>
  )
}
