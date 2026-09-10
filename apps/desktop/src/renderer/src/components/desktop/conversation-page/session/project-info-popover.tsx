import { Folder, FolderClosed, MessageSquare } from "lucide-react"
import { useMemo, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@renderer/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@renderer/components/ui/popover"
import { cn } from "@renderer/lib/utils"
import type { DesktopProject, DesktopSessionRecord } from "@shared/session-types"

export function ProjectInfoButton({
  selectedProject,
  projects,
  cwd,
  sessions,
}: {
  selectedProject: DesktopProject | null
  projects: DesktopProject[]
  cwd: string | null
  sessions: DesktopSessionRecord[]
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const path = cwd ?? selectedProject?.path ?? null
  const project = useMemo(
    () => resolveProject(path, selectedProject, projects),
    [path, projects, selectedProject]
  )
  const name = project?.name ?? (path ? nameFromPath(path) : null)
  const projectSessions = useMemo(
    () => (path ? sessions.filter((session) => samePath(session.cwd, path)) : []),
    [path, sessions]
  )
  const runningCount = projectSessions.filter((session) => session.status === "running").length

  if (!path || !name) return null

  const revealProject = (): void => {
    setOpen(false)
    void window.desktop.workspace.revealPath({ rootPath: path, path: "." })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="项目信息"
            title="项目信息"
            className="text-muted-foreground"
          />
        }
      >
        <FolderClosed />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-86 gap-0 overflow-hidden rounded-xl border-none p-1.5"
      >
        <PopoverTitle className="sr-only">项目信息</PopoverTitle>
        <ItemGroup className="gap-0 has-data-[size=xs]:gap-0">
          <Item size="xs" className="h-9 w-full cursor-default flex-nowrap px-2">
            <ItemMedia variant="icon">
              <FolderClosed className="size-3.5" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="min-w-0 font-semibold">{name}</ItemTitle>
            </ItemContent>
          </Item>
          <ItemSeparator className="my-0 bg-muted" />
          <Item size="xs" className="h-9 w-full cursor-default flex-nowrap px-2">
            <ItemMedia variant="icon">
              <MessageSquare className="size-3.5 text-muted-foreground" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="min-w-0 text-xs text-foreground">
                {`${projectSessions.length} 个会话 · ${runningCount} 个运行中`}
              </ItemTitle>
            </ItemContent>
          </Item>
          <ItemSeparator className="my-0 bg-muted" />
          <Item
            size="xs"
            render={<button type="button" onClick={revealProject} />}
            title="在资源管理器中打开"
            className={cn("h-9 w-full flex-nowrap justify-start px-2 text-left", "hover:bg-muted")}
          >
            <ItemMedia variant="icon">
              <Folder className="size-3.5 text-muted-foreground" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="min-w-0 text-xs text-foreground">{path}</ItemTitle>
            </ItemContent>
          </Item>
        </ItemGroup>
      </PopoverContent>
    </Popover>
  )
}

function resolveProject(
  path: string | null,
  selectedProject: DesktopProject | null,
  projects: DesktopProject[]
): DesktopProject | null {
  if (!path) return selectedProject
  return (
    projects.find((item) => samePath(item.path, path)) ??
    (selectedProject && samePath(selectedProject.path, path) ? selectedProject : null)
  )
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}

function nameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "")
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
