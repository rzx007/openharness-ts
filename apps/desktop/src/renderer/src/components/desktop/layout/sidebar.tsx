import {
  Archive,
  Bell,
  ChevronDown,
  CircleDot,
  Clock3,
  FolderClosed,
  FolderOpen,
  FolderSync,
  GitPullRequest,
  Grid2X2,
  MessageSquarePlus,
  Moon,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  PlugZap,
  Search,
  Settings,
  Smartphone,
  SquarePen,
  SquareTerminal,
  Sun,
  Trash2,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useMemo, useRef, useState } from "react"
import { useMatchRoute } from "@tanstack/react-router"

import { useTheme } from "@renderer/components/theme-provider"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { Field, FieldGroup } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Label } from "@renderer/components/ui/label"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import { isSessionPinned, useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import type { DesktopProject, DesktopSessionRecord } from "@shared/session-types"
import { useSessionActionDialogs } from "../conversation-page/session-action-dialogs"
import { SessionMoreMenu } from "../conversation-page/session-more-menu"

type SidebarProps = {
  open: boolean
  onOpenSettings: () => void
  onOpenScheduled: () => void
  onOpenConversation: (sessionId?: string | null) => void
}

const secondaryNavigation = [
  { icon: GitPullRequest, label: "拉取请求" },
  { icon: Grid2X2, label: "站点" },
  { icon: Clock3, label: "已安排" },
  { icon: PlugZap, label: "插件" },
]

export function Sidebar({
  open,
  onOpenSettings,
  onOpenScheduled,
  onOpenConversation,
}: SidebarProps): React.JSX.Element {
  const matchRoute = useMatchRoute()
  const { theme, setTheme } = useTheme()
  const scheduledSelected = Boolean(matchRoute({ to: "/scheduled" }))
  const darkTheme = isDarkTheme(theme)
  const projects = useDesktopSessionStore((state) => state.projects)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const archivedSessions = useDesktopSessionStore((state) => state.archivedSessions)
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const loadStatus = useDesktopSessionStore((state) => state.loadStatus)
  const startNewConversation = useDesktopSessionStore((state) => state.startNewConversation)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const renameProject = useDesktopSessionStore((state) => state.renameProject)
  const togglePinProject = useDesktopSessionStore((state) => state.togglePinProject)
  const setProjectDefaultShell = useDesktopSessionStore((state) => state.setProjectDefaultShell)
  const removeProject = useDesktopSessionStore((state) => state.removeProject)
  const rebindProject = useDesktopSessionStore((state) => state.rebindProject)
  const sessionActionsDialogs = useSessionActionDialogs()
  const [archiveMode, setArchiveMode] = useState(false)
  const [renameProjectTarget, setRenameProjectTarget] = useState<DesktopProject | null>(null)
  const [shellProjectTarget, setShellProjectTarget] = useState<DesktopProject | null>(null)
  const [removeProjectTarget, setRemoveProjectTarget] = useState<DesktopProject | null>(null)
  const [projectName, setProjectName] = useState("")
  const [projectShell, setProjectShell] = useState("")
  const [busy, setBusy] = useState(false)
  const [projectExpansion, setProjectExpansion] = useState<Record<string, boolean>>({})
  const recentSessions = useMemo(() => {
    const recentIds = new Set(sessions.slice(0, 4).map((session) => session.id))
    return sessions.filter((session) => !session.projectId || recentIds.has(session.id))
  }, [sessions])
  const activeProjectPath = useMemo(() => {
    const session = sessions.find((item) => item.id === activeSessionId)
    return session ? normalizePath(session.cwd) : null
  }, [activeSessionId, sessions])

  const notify = (): void => {
    void window.desktop.tray.notify({
      title: "OpenHarness",
      body: "通知中心已连接。",
      showWhenFocused: true,
    })
  }

  const beginNewConversation = (project?: DesktopProject): void => {
    setArchiveMode(false)
    void (async () => {
      await startNewConversation()
      if (project) await selectProject(project)
      onOpenConversation(null)
    })()
  }

  const beginProjectRename = (project: DesktopProject): void => {
    setProjectName(project.name)
    setRenameProjectTarget(project)
  }

  const beginProjectShellSettings = (project: DesktopProject): void => {
    setProjectShell(project.defaultShell ?? "")
    setShellProjectTarget(project)
  }

  const submitProjectRename = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!renameProjectTarget || !projectName.trim() || busy) return
    setBusy(true)
    void renameProject(renameProjectTarget.path, projectName)
      .then(() => setRenameProjectTarget(null))
      .finally(() => setBusy(false))
  }

  const confirmProjectRemove = (): void => {
    if (!removeProjectTarget || busy) return
    setBusy(true)
    void removeProject(removeProjectTarget.path)
      .then(() => setRemoveProjectTarget(null))
      .finally(() => setBusy(false))
  }

  const submitProjectShell = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!shellProjectTarget || busy) return
    setBusy(true)
    void setProjectDefaultShell(shellProjectTarget.path, projectShell)
      .then(() => setShellProjectTarget(null))
      .finally(() => setBusy(false))
  }

  const sessionActions: SessionActions = {
    onOpen: (session) => {
      onOpenConversation(session.id)
    },
    onRename: sessionActionsDialogs.beginRename,
    onArchive: sessionActionsDialogs.beginArchive,
    onDelete: sessionActionsDialogs.beginDelete,
  }
  const projectActions: ProjectActions = {
    onRename: beginProjectRename,
    onTogglePin: (project) => void togglePinProject(project.path),
    onSetDefaultShell: beginProjectShellSettings,
    onRemove: setRemoveProjectTarget,
    onRebind: (project) => void rebindProject(project.id),
  }

  return (
    <>
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
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="搜索"
              aria-label="搜索"
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Search />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="通知"
              aria-label="通知"
              onClick={notify}
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Bell />
            </Button>
          </div>
        </div>

        <nav className="min-w-0 px-2" aria-label="主要导航">
          <SidebarNavigationButton
            icon={SquarePen}
            label="新对话"
            onClick={() => beginNewConversation()}
          />
          {secondaryNavigation.map(({ icon, label }) => {
            const isScheduled = label === "已安排"
            return (
              <SidebarNavigationButton
                key={label}
                icon={icon}
                label={label}
                selected={isScheduled && scheduledSelected}
                onClick={
                  isScheduled
                    ? () => {
                        setArchiveMode(false)
                        onOpenScheduled()
                      }
                    : undefined
                }
              />
            )
          })}
          <SidebarNavigationButton
            icon={Archive}
            label="已归档"
            selected={archiveMode && !scheduledSelected}
            onClick={() => {
              onOpenConversation()
              setArchiveMode((current) => !current)
            }}
          />
        </nav>

        <ScrollArea
          horizontal={false}
          className="min-h-0 min-w-0 flex-1"
          viewportClassName="px-2 pt-4"
          contentClassName="pb-4"
        >
          {archiveMode ? (
            <ArchivedSessionList
              sessions={archivedSessions}
              activeSessionId={activeSessionId}
              actions={sessionActions}
            />
          ) : (
            <>
              <SidebarSectionLabel>项目</SidebarSectionLabel>
              {loadStatus === "loading" && projects.length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-sidebar-muted">正在加载项目...</p>
              ) : (
                <div className="space-y-0.5">
                  {projects.map((project, index) => {
                    const path = normalizePath(project.path)
                    const defaultExpanded = activeProjectPath
                      ? activeProjectPath === path
                      : index === 0
                    const expanded = projectExpansion[path] ?? defaultExpanded
                    return (
                      <ProjectGroup
                        key={project.path}
                        project={project}
                        sessions={sessions.filter((session) => samePath(session.cwd, project.path))}
                        activeSessionId={activeSessionId}
                        expanded={expanded}
                        onToggle={() =>
                          setProjectExpansion((current) => ({ ...current, [path]: !expanded }))
                        }
                        projectActions={projectActions}
                        actions={sessionActions}
                      />
                    )
                  })}
                </div>
              )}

              {recentSessions.length > 0 ? (
                <>
                  <SidebarSectionLabel className="mt-5">最近</SidebarSectionLabel>
                  <div>
                    {recentSessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={activeSessionId === session.id}
                        actions={sessionActions}
                        nested={false}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </>
          )}
        </ScrollArea>

        <div className="min-w-0 px-2 py-2">
          <button
            type="button"
            className="flex h-9 w-full items-center rounded-md bg-background px-3 text-left shadow-sm ring-1 ring-black/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <CircleDot className="mr-2 size-4 text-sidebar-muted" />
            <span className="text-[13px] font-medium">开始使用</span>
            <span className="ml-auto text-xs text-sidebar-muted">1/3</span>
          </button>
        </div>

        <div className="flex min-w-0 items-center justify-between border-t border-sidebar-border/80 px-2 py-2">
          <Button
            type="button"
            variant="ghost"
            title="设置"
            aria-label="打开设置"
            onClick={onOpenSettings}
            className="flex-1 justify-start text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <Settings />
            设置
          </Button>
          <div className="flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="手机"
              aria-label="手机"
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Smartphone />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={darkTheme ? "切换到浅色主题" : "切换到深色主题"}
              aria-label={darkTheme ? "切换到浅色主题" : "切换到深色主题"}
              onClick={() => setTheme(darkTheme ? "light" : "dark")}
              className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              {darkTheme ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </aside>

      {sessionActionsDialogs.dialogs}

      <Dialog
        open={renameProjectTarget !== null}
        onOpenChange={(value) => !value && setRenameProjectTarget(null)}
      >
        <DialogContent>
          <form onSubmit={submitProjectRename} className="contents">
            <DialogHeader>
              <DialogTitle>重命名项目</DialogTitle>
              <DialogDescription>
                只修改 OpenHarness 中显示的名称，不会重命名磁盘目录。
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <Label htmlFor="project-name">项目名称</Label>
                <Input
                  id="project-name"
                  name="name"
                  autoFocus
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  maxLength={80}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">取消</Button>} />
              <Button type="submit" disabled={!projectName.trim() || busy}>
                {busy ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={shellProjectTarget !== null}
        onOpenChange={(value) => !value && setShellProjectTarget(null)}
      >
        <DialogContent>
          <form onSubmit={submitProjectShell} className="contents">
            <DialogHeader>
              <DialogTitle>设置默认 Shell</DialogTitle>
              <DialogDescription>
                只影响这个项目新开的终端。留空会继续使用当前系统默认 Shell。
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <Label htmlFor="project-shell">默认 Shell</Label>
                <Input
                  id="project-shell"
                  name="shell"
                  autoFocus
                  value={projectShell}
                  onChange={(event) => setProjectShell(event.target.value)}
                  placeholder="pwsh.exe / powershell.exe / C:\\Program Files\\Git\\bin\\bash.exe"
                />
              </Field>
            </FieldGroup>
            <div className="rounded-md bg-muted/55 px-3 py-2 text-[11.5px] leading-5 text-muted-foreground">
              当前项目：{shellProjectTarget?.name}
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">取消</Button>} />
              <Button type="submit" disabled={busy}>
                {busy ? "保存中..." : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeProjectTarget !== null}
        onOpenChange={(value) => !value && setRemoveProjectTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从列表移除项目？</DialogTitle>
            <DialogDescription>
              “{removeProjectTarget?.name}
              ”将不再出现在项目列表中。磁盘目录和已有会话都会保留，之后可以重新选择该目录恢复项目。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">取消</Button>} />
            <Button variant="destructive" disabled={busy} onClick={confirmProjectRemove}>
              {busy ? "移除中..." : "从列表移除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

type SessionActions = {
  onOpen: (session: DesktopSessionRecord) => void
  onRename: (session: DesktopSessionRecord) => void
  onArchive: (session: DesktopSessionRecord) => void
  onDelete: (session: DesktopSessionRecord) => void
}

type ProjectActions = {
  onRename: (project: DesktopProject) => void
  onTogglePin: (project: DesktopProject) => void
  onSetDefaultShell: (project: DesktopProject) => void
  onRemove: (project: DesktopProject) => void
  onRebind: (project: DesktopProject) => void
}

function SessionRow({
  session,
  active,
  actions,
  archived = false,
  nested = true,
}: {
  session: DesktopSessionRecord
  active: boolean
  actions: SessionActions
  archived?: boolean
  nested?: boolean
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pinned = isSessionPinned(session)
  const running = !archived && session.status === "running"
  const title = sessionTitle(session)

  return (
    <div
      className="group/session relative flex min-w-0 items-center"
      onContextMenu={(event) => {
        event.preventDefault()
        triggerRef.current?.click()
      }}
    >
      <button
        type="button"
        onClick={() => actions.onOpen(session)}
        className={cn(
          "h-7.5 min-w-0 flex-1 truncate rounded-md pr-8 text-left text-[12.5px] leading-7.5 font-normal transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          nested ? "pl-8" : "pl-2.5",
          active
            ? "bg-sidebar-selected text-sidebar-foreground"
            : "text-sidebar-foreground/82 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        )}
      >
        {pinned ? <Pin className="mr-1 inline size-3 -translate-y-px text-sidebar-muted" /> : null}
        {title}
      </button>
      <SessionMoreMenu
        session={session}
        archived={archived}
        align="end"
        triggerRef={triggerRef}
        trigger={
          <button
            type="button"
            aria-label={running ? `${title} 正在运行，打开更多操作` : `管理会话 ${title}`}
            title={running ? "会话运行中" : "更多操作"}
            className={cn(
              "absolute right-1 grid size-6 place-items-center rounded text-sidebar-muted transition-opacity outline-none hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent data-popup-open:opacity-100 [&_svg]:size-3.5",
              running ? "opacity-100" : "opacity-0 group-hover/session:opacity-100"
            )}
          />
        }
        onRename={() => actions.onRename(session)}
        onArchive={() => actions.onArchive(session)}
        onDelete={() => actions.onDelete(session)}
      >
        {running ? (
          <>
            <Spinner
              aria-hidden="true"
              className="size-3.5 group-hover/session:hidden in-data-popup-open:hidden"
            />
            <MoreHorizontal className="hidden group-hover/session:inline in-data-popup-open:inline" />
          </>
        ) : (
          <MoreHorizontal />
        )}
      </SessionMoreMenu>
    </div>
  )
}

function ProjectGroup({
  project,
  sessions,
  activeSessionId,
  expanded,
  onToggle,
  projectActions,
  actions,
}: {
  project: DesktopProject
  sessions: DesktopSessionRecord[]
  activeSessionId: string | null
  expanded: boolean
  onToggle: () => void
  projectActions: ProjectActions
  actions: SessionActions
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const visibleSessions = showAll ? sessions : sessions.slice(0, 5)

  return (
    <section>
      <DropdownMenu>
        <div
          className="group/project relative flex min-w-0 items-center"
          onContextMenu={(event) => {
            event.preventDefault()
            triggerRef.current?.click()
          }}
        >
          <button
            type="button"
            title={project.path}
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex h-7.5 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 pr-8 text-left text-[12.5px] font-[450] text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {expanded ? (
              <FolderOpen className="size-3.75 shrink-0 text-sidebar-muted" strokeWidth={1.7} />
            ) : (
              <FolderClosed className="size-3.75 shrink-0 text-sidebar-muted" strokeWidth={1.7} />
            )}
            <span className="truncate">{project.name}</span>
            {!project.available ? (
              <span className="shrink-0 text-[10px] font-normal text-amber-600">目录不可用</span>
            ) : null}
            {project.pinnedAt ? (
              <Pin className="ml-auto size-3 shrink-0 text-sidebar-muted" />
            ) : null}
          </button>
          <DropdownMenuTrigger
            ref={triggerRef}
            aria-label={`管理项目 ${project.name}`}
            title="更多操作"
            className="absolute right-1 grid size-6 place-items-center rounded text-sidebar-muted opacity-0 transition-opacity outline-none group-hover/project:opacity-100 hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-accent data-popup-open:opacity-100 [&_svg]:size-3.5"
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuItem onClick={() => projectActions.onTogglePin(project)}>
            {project.pinnedAt ? <PinOff /> : <Pin />}
            {project.pinnedAt ? "取消置顶项目" : "置顶项目"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void window.desktop.workspace.revealPath({ rootPath: project.path, path: "." })
            }
          >
            <FolderOpen />
            在资源管理器中打开
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => projectActions.onRebind(project)}>
            <FolderSync />
            重新绑定目录
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => projectActions.onSetDefaultShell(project)}>
            <SquareTerminal />
            设置默认 Shell
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => projectActions.onRename(project)}>
            <Pencil />
            重命名项目
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => projectActions.onRemove(project)}>
            <Trash2 />
            从列表移除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AnimatePresence initial={false}>
        {expanded && sessions.length > 0 ? (
          <motion.div
            key="project-history"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.14, ease: "easeOut" },
            }}
            className="overflow-hidden"
          >
            <div className="pb-1">
              {visibleSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={activeSessionId === session.id}
                  actions={actions}
                />
              ))}
              {sessions.length > 5 ? (
                <button
                  type="button"
                  onClick={() => setShowAll((current) => !current)}
                  className="flex h-7 w-full items-center rounded-md pr-2 pl-8 text-left text-[11.5px] font-normal text-sidebar-muted/65 transition-colors hover:bg-sidebar-accent hover:text-sidebar-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {showAll ? "收起" : "展开显示"}
                </button>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  )
}

function ArchivedSessionList({
  sessions,
  activeSessionId,
  actions,
}: {
  sessions: DesktopSessionRecord[]
  activeSessionId: string | null
  actions: SessionActions
}): React.JSX.Element {
  return (
    <section>
      <SidebarSectionLabel>已归档</SidebarSectionLabel>
      {sessions.length === 0 ? (
        <p className="px-2.5 py-2 text-xs leading-5 text-sidebar-muted">还没有归档的会话。</p>
      ) : (
        sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={activeSessionId === session.id}
            actions={actions}
            archived
            nested={false}
          />
        ))
      )}
    </section>
  )
}

function SidebarNavigationButton({
  icon: Icon,
  label,
  selected = false,
  onClick,
}: {
  icon: typeof MessageSquarePlus
  label: string
  selected?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-[450] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected && "bg-sidebar-selected"
      )}
    >
      <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
      <span>{label}</span>
    </button>
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
    <div className={cn("px-2.5 pb-1.5 text-[13px] font-normal text-sidebar-muted/70", className)}>
      {children}
    </div>
  )
}

function sessionTitle(session: DesktopSessionRecord): string {
  const title = session.title.trim()
  return title && title !== "TUI" ? title : "新对话"
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}

function isDarkTheme(theme: "dark" | "light" | "system"): boolean {
  if (theme === "dark") return true
  if (theme === "light") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}
