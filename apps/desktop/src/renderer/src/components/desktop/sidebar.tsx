import {
  Bell,
  Bot,
  ChevronDown,
  CircleDot,
  Clock3,
  Folder,
  GitPullRequest,
  Grid2X2,
  MessageSquarePlus,
  PlugZap,
  Search,
} from "lucide-react"
import { useMemo } from "react"

import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import type { DesktopProject, DesktopSessionRecord } from "@shared/session-types"

type SidebarProps = {
  open: boolean
}

const secondaryNavigation = [
  { icon: GitPullRequest, label: "拉取请求" },
  { icon: Grid2X2, label: "站点" },
  { icon: Clock3, label: "已安排" },
  { icon: PlugZap, label: "插件" },
]

export function Sidebar({ open }: SidebarProps): React.JSX.Element {
  const projects = useDesktopSessionStore((state) => state.projects)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const loadStatus = useDesktopSessionStore((state) => state.loadStatus)
  const openSession = useDesktopSessionStore((state) => state.openSession)
  const startNewConversation = useDesktopSessionStore((state) => state.startNewConversation)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const recentSessions = useMemo(() => sessions.slice(0, 4), [sessions])

  const notify = (): void => {
    void window.desktop.tray.notify({
      title: "OpenHarness",
      body: "通知中心已连接。",
      showWhenFocused: true,
    })
  }

  const beginNewConversation = (project?: DesktopProject): void => {
    void (async () => {
      await startNewConversation()
      if (project) await selectProject(project)
    })()
  }

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-transparent",
        !open && "pointer-events-none"
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-4 pt-2 pb-2">
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md px-1.5 text-[15px] font-semibold hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          OpenHarness
          <ChevronDown className="size-3.5 text-sidebar-muted" />
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <SidebarIconButton label="搜索">
            <Search />
          </SidebarIconButton>
          <SidebarIconButton label="通知" onClick={notify}>
            <Bell />
          </SidebarIconButton>
        </div>
      </div>

      <nav className="min-w-0 px-2" aria-label="主要导航">
        <button
          type="button"
          onClick={() => beginNewConversation()}
          className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-[450] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <MessageSquarePlus className="size-4 text-sidebar-muted" strokeWidth={1.8} />
          <span>新对话</span>
        </button>
        {secondaryNavigation.map(({ icon: Icon, label }) => (
          <button
            key={label}
            type="button"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-[450] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportClassName="px-2 pt-4"
        contentClassName="pb-4"
      >
        <SidebarSectionLabel>项目</SidebarSectionLabel>
        {loadStatus === "loading" && projects.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-sidebar-muted">正在加载项目...</p>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <ProjectGroup
                key={project.path}
                project={project}
                sessions={sessions.filter((session) => samePath(session.cwd, project.path))}
                activeSessionId={activeSessionId}
                onProjectClick={() => beginNewConversation(project)}
                onSessionClick={(sessionId) => void openSession(sessionId)}
              />
            ))}
          </div>
        )}

        {recentSessions.length > 0 ? (
          <>
            <SidebarSectionLabel className="mt-5">最近</SidebarSectionLabel>
            <div>
              {recentSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => void openSession(session.id)}
                  className={cn(
                    "block h-8 w-full truncate rounded-md px-2.5 text-left text-[12.5px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    activeSessionId === session.id && "bg-sidebar-selected font-[450]"
                  )}
                >
                  {sessionTitle(session)}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </ScrollArea>

      <div className="min-w-0 border-t border-sidebar-border px-2 py-2">
        <button
          type="button"
          className="flex h-11 w-full items-center rounded-xl bg-background px-3 text-left shadow-sm ring-1 ring-black/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <CircleDot className="mr-2 size-4 text-sidebar-muted" />
          <span className="text-[13px] font-medium">开始使用</span>
          <span className="ml-auto text-xs text-sidebar-muted">1/3</span>
        </button>
      </div>

      <div className="flex min-w-0 items-center border-t border-sidebar-border px-4 py-3">
        <span className="grid size-6 place-items-center rounded-full bg-amber-400 text-[10px] font-semibold text-amber-950">
          OH
        </span>
        <span className="ml-2 text-[13px] font-medium">OpenHarness</span>
        <button
          type="button"
          title="桌面宠物"
          aria-label="显示桌面宠物"
          onClick={() => void window.desktop.pet.show()}
          className="ml-auto grid size-7 place-items-center rounded-full bg-orange-500/15 text-orange-700 transition-colors hover:bg-orange-500/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5"
        >
          <Bot />
        </button>
      </div>
    </aside>
  )
}

function ProjectGroup({
  project,
  sessions,
  activeSessionId,
  onProjectClick,
  onSessionClick,
}: {
  project: DesktopProject
  sessions: DesktopSessionRecord[]
  activeSessionId: string | null
  onProjectClick: () => void
  onSessionClick: (sessionId: string) => void
}): React.JSX.Element {
  return (
    <section>
      <button
        type="button"
        title={project.path}
        onClick={onProjectClick}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] font-[450] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Folder className="size-4 text-sidebar-muted" strokeWidth={1.8} />
        <span className="truncate">{project.name}</span>
      </button>
      {sessions.length > 0 ? (
        <div className="mt-0.5">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSessionClick(session.id)}
              className={cn(
                "block h-8 w-full truncate rounded-md pr-2 pl-8 text-left text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                activeSessionId === session.id
                  ? "bg-sidebar-selected font-[450] text-sidebar-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              )}
            >
              {sessionTitle(session)}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function SidebarSectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn("px-2.5 pb-2 text-xs font-medium text-sidebar-muted", className)}>
      {children}
    </div>
  )
}

function SidebarIconButton({
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
      className="grid size-8 place-items-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

function sessionTitle(session: DesktopSessionRecord): string {
  const title = session.title.trim()
  return title && title !== "TUI" ? title : "新对话"
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
  return normalize(left) === normalize(right)
}
