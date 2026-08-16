import {
  FileText,
  Folder,
  Globe2,
  MessageCirclePlus,
  Minimize2,
  PanelRightClose,
  Plus,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react"
import type * as React from "react"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

import { BrowserTool, type BrowserToolTab } from "@renderer/components/desktop/tools/browser-tool"
import { FilesTool } from "@renderer/components/desktop/tools/files-tool"
import { getFileIcon } from "@renderer/components/desktop/tools/file-icons"
import type { FileViewerTab } from "@renderer/components/desktop/tools/file-viewer"
import { PlaceholderTool } from "@renderer/components/desktop/tools/placeholder-tool"
import { TerminalTool } from "@renderer/components/desktop/tools/terminal/terminal-tool"
import type {
  TerminalPanelCommand,
  TerminalSessionTabInfo,
} from "@renderer/components/desktop/tools/terminal/terminal-tool"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"

type UtilityTool = "review" | "terminal" | "browser" | "files" | "side-chat"

type UtilityTab = {
  id: string
  tool: UtilityTool
  title: string
  filePath?: string
  fileIcon?: LucideIcon
  fileType?: FileViewerTab["type"]
  projectPath?: string
  terminalId?: string
}

type UtilityPanelProps = {
  open: boolean
  maximized: boolean
  onToggleMaximized: () => void
  onClose: () => void
  fileOpenRequest: { id: number; path: string; line?: number } | null
  terminalOpenRequest: { id: number; terminalId: string } | null
}

type MenuPosition = {
  left: number
  top: number
}

type PersistedFileTabState = Record<
  string,
  {
    activePath: string | null
    paths: string[]
  }
>

const toolMeta: Record<
  UtilityTool,
  {
    icon: LucideIcon
    label: string
    shortcut?: string
  }
> = {
  review: { icon: FileText, label: "审阅", shortcut: "Ctrl+Shift+G" },
  terminal: { icon: SquareTerminal, label: "终端" },
  browser: { icon: Globe2, label: "浏览器", shortcut: "Ctrl+T" },
  files: { icon: Folder, label: "文件", shortcut: "Ctrl+P" },
  "side-chat": { icon: MessageCirclePlus, label: "侧边聊天", shortcut: "Ctrl+Alt+S" },
}

const toolOrder: UtilityTool[] = ["review", "terminal", "browser", "files", "side-chat"]
const filesTabId = "files-tab"
const unavailableTerminalTabId = "terminal-tab:unavailable"
const persistedFileTabsKey = "openharness.desktop.file-tabs.v1"

export function UtilityPanel({
  open,
  maximized,
  onToggleMaximized,
  onClose,
  fileOpenRequest,
  terminalOpenRequest,
}: UtilityPanelProps): React.JSX.Element {
  const [tabs, setTabs] = useState<UtilityTab[]>([])
  const [browserTabs, setBrowserTabs] = useState<BrowserToolTab[]>([])
  const [fileTabs, setFileTabs] = useState<FileViewerTab[]>([])
  const [fileProjectPath, setFileProjectPath] = useState<string | null>(null)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null)
  const [activeTabId, setActiveTabId] = useState("")
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [addMenuPosition, setAddMenuPosition] = useState<MenuPosition | null>(null)
  const [terminalMounted, setTerminalMounted] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState<TerminalPanelCommand | null>(null)
  const [terminalActionsHost, setTerminalActionsHost] = useState<HTMLDivElement | null>(null)
  const [persistedFileTabs, setPersistedFileTabs] =
    useState<PersistedFileTabState>(readPersistedFileTabs)
  const selectedProjectPath = useDesktopSessionStore((state) => state.selectedProject?.path)
  const selectedProjectAvailable = useDesktopSessionStore(
    (state) => state.selectedProject?.available ?? false
  )
  const persistedFileState = selectedProjectPath
    ? persistedFileTabs[selectedProjectPath]
    : undefined
  const fileStateVisible = fileProjectPath === (selectedProjectPath ?? null)
  const visibleFileTabs = fileStateVisible ? fileTabs : []
  const visibleActiveFilePath = fileStateVisible ? activeFilePath : null
  const visibleLoadingFilePath = fileStateVisible ? loadingFilePath : null
  const visibleTabs = tabs.filter(
    (tab) => !tab.projectPath || tab.projectPath === selectedProjectPath
  )
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? visibleTabs[0]
  const pendingTerminal =
    Boolean(terminalOpenRequest) ||
    terminalCommand?.type === "ensure" ||
    terminalCommand?.type === "create"

  useEffect(() => {
    if (!fileOpenRequest) return
    const relativePath = toRelativeWorkspacePath(fileOpenRequest.path, selectedProjectPath)
    const timer = window.setTimeout(() => {
      if (!relativePath) {
        setTabs((current) =>
          current.some((tab) => tab.id === filesTabId || tab.tool === "files")
            ? current
            : [...current, { id: filesTabId, tool: "files", title: toolMeta.files.label }]
        )
        setActiveTabId(filesTabId)
        return
      }
      const id = fileTabId(relativePath, selectedProjectPath)
      setTabs((current) =>
        placeFileTab(current, {
          id,
          tool: "files",
          title: fileNameFromPath(relativePath),
          filePath: relativePath,
          fileIcon: getFileIcon(relativePath),
          projectPath: selectedProjectPath,
        })
      )
      setFileProjectPath(selectedProjectPath ?? null)
      setActiveTabId(id)
      setActiveFilePath(relativePath)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fileOpenRequest, selectedProjectPath])

  useEffect(() => {
    if (!terminalOpenRequest) return
    setTerminalMounted(true)
  }, [terminalOpenRequest])

  const addTab = (tool: UtilityTool): void => {
    setAddMenuOpen(false)

    if (tool === "terminal") {
      setTerminalMounted(true)
      if (!selectedProjectPath || !selectedProjectAvailable) {
        const id = unavailableTerminalTabId
        setTabs((current) =>
          current.some((tab) => tab.id === id)
            ? current
            : [...current, { id, tool, title: toolMeta.terminal.label }]
        )
        setActiveTabId(id)
        return
      }
      const hasTerminalTabs = tabs.some(
        (tab) =>
          tab.tool === "terminal" && tab.terminalId && tab.projectPath === selectedProjectPath
      )
      setTerminalCommand({
        id: Date.now(),
        type: hasTerminalTabs ? "create" : "ensure",
      })
      return
    }

    if (tool === "browser") {
      const id = `browser-tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const tab: BrowserToolTab = {
        id,
        title: "新标签页",
        url: null,
        input: "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }
      setBrowserTabs((current) => [...current, tab])
      setTabs((current) => [...current, { id, tool, title: tab.title }])
      setActiveTabId(id)
      return
    }

    if (tool === "files") {
      const emptyFilesTab = tabs.find((tab) => tab.id === filesTabId)
      if (emptyFilesTab) {
        setActiveTabId(emptyFilesTab.id)
        return
      }
      const existingFileTab =
        tabs.find(
          (tab) =>
            tab.tool === "files" &&
            tab.filePath &&
            tab.filePath === activeFilePath &&
            tab.projectPath === selectedProjectPath
        ) ??
        tabs.find(
          (tab) => tab.tool === "files" && tab.filePath && tab.projectPath === selectedProjectPath
        )
      if (existingFileTab) {
        setActiveTabId(existingFileTab.id)
        return
      }
      setTabs((current) => [...current, { id: filesTabId, tool, title: toolMeta.files.label }])
      setActiveTabId(filesTabId)
      return
    }

    const id = toolTabId(tool)
    const existing = tabs.find((tab) => tab.id === id)
    if (existing) {
      setActiveTabId(existing.id)
      return
    }

    setTabs((current) => [...current, { id, tool, title: toolMeta[tool].label }])
    setActiveTabId(id)
  }

  const closeTabs = (tabIds: string[], preferredActiveTabId?: string): void => {
    const closingIds = new Set(tabIds)
    if (closingIds.size === 0) return

    const closingTabs = tabs.filter((tab) => closingIds.has(tab.id))
    const closingFilePaths = new Set(
      closingTabs.map((tab) => tab.filePath).filter((path): path is string => Boolean(path))
    )
    const closingTerminalIds = closingTabs
      .map((tab) => tab.terminalId)
      .filter((terminalId): terminalId is string => Boolean(terminalId))

    setBrowserTabs((current) => current.filter((tab) => !closingIds.has(tab.id)))

    if (closingFilePaths.size > 0) {
      const nextFileTabs = visibleFileTabs.filter((tab) => !closingFilePaths.has(tab.preview.path))
      const preferredTab = tabs.find((tab) => tab.id === preferredActiveTabId)
      const preferredFilePath = preferredTab?.filePath
      const nextActivePath =
        preferredFilePath && !closingFilePaths.has(preferredFilePath)
          ? preferredFilePath
          : preferredTab && !preferredTab.filePath
            ? (nextFileTabs[0]?.preview.path ?? null)
            : activeFilePath && !closingFilePaths.has(activeFilePath)
              ? activeFilePath
              : (nextFileTabs[0]?.preview.path ?? null)

      setFileTabs((current) => current.filter((tab) => !closingFilePaths.has(tab.preview.path)))
      setActiveFilePath(nextActivePath)
      persistFileTabs(
        nextFileTabs.map((tab) => tab.preview.path),
        nextActivePath
      )
    }

    setTabs((current) => {
      const nextTabs = current.filter((tab) => !closingIds.has(tab.id))
      if (nextTabs.length === 0) {
        setActiveTabId("")
        setActiveFilePath(null)
        return []
      }

      const visibleNextTabs = nextTabs.filter(
        (tab) => !tab.projectPath || tab.projectPath === selectedProjectPath
      )
      const preferredTab = preferredActiveTabId
        ? visibleNextTabs.find((tab) => tab.id === preferredActiveTabId)
        : undefined
      const fallbackTab = closingIds.has(activeTabId)
        ? (visibleNextTabs[0] ?? nextTabs[0])
        : (visibleNextTabs.find((tab) => tab.id === activeTabId) ??
          visibleNextTabs[0] ??
          nextTabs[0])
      const nextActive = preferredTab ?? fallbackTab
      setActiveTabId(nextActive.id)
      if (nextActive.filePath) setActiveFilePath(nextActive.filePath)
      return nextTabs
    })

    closingTerminalIds.forEach((terminalId, index) => {
      window.setTimeout(() => {
        setTerminalCommand({
          id: Date.now() + index,
          type: "close",
          terminalId,
        })
      }, index * 30)
    })
  }

  const closeTab = (tabId: string): void => {
    closeTabs([tabId])
  }

  const selectTab = (tab: UtilityTab): void => {
    setActiveTabId(tab.id)
    if (tab.filePath) {
      setActiveFilePath(tab.filePath)
      persistFileTabs(
        visibleFileTabs.map((item) => item.preview.path),
        tab.filePath
      )
    }
  }

  const startFileTab = (path: string): void => {
    const id = fileTabId(path, selectedProjectPath)
    setTabs((current) =>
      placeFileTab(current, {
        id,
        tool: "files",
        title: fileNameFromPath(path),
        filePath: path,
        fileIcon: getFileIcon(path),
        projectPath: selectedProjectPath,
      })
    )
    setFileProjectPath(selectedProjectPath ?? null)
    setActiveTabId(id)
    setActiveFilePath(path)
  }

  const upsertFileTab = (nextFileTab: FileViewerTab): void => {
    const id = fileTabId(nextFileTab.preview.path, selectedProjectPath)
    const nextPaths = [
      nextFileTab.preview.path,
      ...visibleFileTabs
        .map((tab) => tab.preview.path)
        .filter((path) => path !== nextFileTab.preview.path),
    ]
    setFileProjectPath(selectedProjectPath ?? null)
    setFileTabs((current) => {
      const scopedCurrent = fileProjectPath === (selectedProjectPath ?? null) ? current : []
      return [
        nextFileTab,
        ...scopedCurrent.filter((tab) => tab.preview.path !== nextFileTab.preview.path),
      ]
    })
    setTabs((current) =>
      placeFileTab(current, {
        id,
        tool: "files",
        title: nextFileTab.preview.name,
        filePath: nextFileTab.preview.path,
        fileIcon: getFileIcon(nextFileTab.preview.path),
        fileType: nextFileTab.type,
        projectPath: selectedProjectPath,
      })
    )
    setActiveTabId(id)
    setActiveFilePath(nextFileTab.preview.path)
    persistFileTabs(nextPaths, nextFileTab.preview.path)
  }

  const persistFileTabs = (paths: string[], activePath: string | null): void => {
    if (!selectedProjectPath) return
    setPersistedFileTabs((current) => {
      const nextState = { ...current }
      if (paths.length === 0) {
        delete nextState[selectedProjectPath]
      } else {
        nextState[selectedProjectPath] = {
          activePath,
          paths: paths.slice(0, 12),
        }
      }
      writePersistedFileTabs(nextState)
      return nextState
    })
  }

  const updateBrowserTab = (tabId: string, patch: Partial<BrowserToolTab>): void => {
    setBrowserTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
    )
    if (patch.title) {
      setTabs((current) =>
        current.map((tab) => (tab.id === tabId ? { ...tab, title: patch.title ?? tab.title } : tab))
      )
    }
  }

  const upsertTerminalTab = (session: TerminalSessionTabInfo, activate: boolean): void => {
    const id = terminalTabId(session.id)
    setTabs((current) => {
      if (current.some((tab) => tab.id === id)) {
        return current.map((tab) => (tab.id === id ? { ...tab, title: session.title } : tab))
      }
      return [
        ...current.filter((tab) => tab.id !== unavailableTerminalTabId),
        {
          id,
          tool: "terminal",
          title: session.title,
          terminalId: session.id,
          projectPath: selectedProjectPath,
        },
      ]
    })
    if (activate) setActiveTabId(id)
  }

  const removeTerminalTab = (terminalId: string): void => {
    const id = terminalTabId(terminalId)
    setTabs((current) => {
      if (!current.some((tab) => tab.id === id)) return current
      const nextTabs = current.filter((tab) => tab.id !== id)
      if (nextTabs.length === 0) {
        setActiveTabId("")
        return []
      }
      if (activeTabId === id) {
        const previousIndex = current.findIndex((tab) => tab.id === id)
        const nextActive = nextTabs[Math.max(0, previousIndex - 1)] ?? nextTabs[0]
        setActiveTabId(nextActive.id)
        if (nextActive.filePath) setActiveFilePath(nextActive.filePath)
      }
      return nextTabs
    })
  }

  const hydrateTerminalTabs = (sessions: TerminalSessionTabInfo[]): void => {
    setTabs((current) => {
      const others = current.filter(
        (tab) =>
          tab.tool !== "terminal" || (tab.projectPath && tab.projectPath !== selectedProjectPath)
      )
      const terminalTabs = sessions.map((session) => ({
        id: terminalTabId(session.id),
        tool: "terminal" as const,
        title: session.title,
        terminalId: session.id,
        projectPath: selectedProjectPath,
      }))
      return [...others.filter((tab) => tab.id !== unavailableTerminalTabId), ...terminalTabs]
    })
  }

  const handleActiveTerminalChange = (terminalId: string | null): void => {
    if (terminalId) setActiveTabId(terminalTabId(terminalId))
  }

  const toggleAddMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 320
    setAddMenuPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12)),
      top: rect.bottom + 4,
    })
    setAddMenuOpen((current) => !current)
  }

  const closeOtherTabs = (tab: UtilityTab): void => {
    selectTab(tab)
    closeTabs(
      visibleTabs.filter((item) => item.id !== tab.id).map((item) => item.id),
      tab.id
    )
  }

  const closeTabsToRight = (tab: UtilityTab): void => {
    const index = visibleTabs.findIndex((item) => item.id === tab.id)
    if (index < 0) return
    selectTab(tab)
    closeTabs(
      visibleTabs.slice(index + 1).map((item) => item.id),
      tab.id
    )
  }

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full min-h-0 w-full overflow-hidden bg-panel transition-opacity duration-150 ease-out",
        open ? "border-l opacity-100" : "pointer-events-none opacity-0"
      )}
    >
      <div className="flex h-full min-w-[320px] flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 bg-panel px-2.5">
          <div className="utility-tab-strip flex min-w-0 flex-1 items-center overflow-x-auto">
            {visibleTabs.map((tab, index) => (
              <UtilityTabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeTab?.id}
                loading={browserTabs.find((item) => item.id === tab.id)?.loading}
                showSeparator={index < visibleTabs.length - 1}
                tabCount={visibleTabs.length}
                rightCount={visibleTabs.length - index - 1}
                onSelect={() => selectTab(tab)}
                onClose={() => closeTab(tab.id)}
                onCloseOthers={() => closeOtherTabs(tab)}
                onCloseRight={() => closeTabsToRight(tab)}
              />
            ))}
            {visibleTabs.length > 0 && (
              <div className="relative ml-1 shrink-0">
                <PanelIconButton label="新建工具标签" onClick={toggleAddMenu} subtle>
                  <Plus />
                </PanelIconButton>
              </div>
            )}
          </div>

          <div
            ref={setTerminalActionsHost}
            className="flex shrink-0 items-center gap-0.5 text-ui-muted"
          />

          <PanelIconButton
            label={maximized ? "恢复面板" : "最大化面板"}
            pressed={maximized}
            onClick={onToggleMaximized}
            subtle
          >
            <Minimize2 className={cn(!maximized && "rotate-180", "size-3.5")} />
          </PanelIconButton>
          <PanelIconButton label="关闭面板" onClick={onClose}>
            <PanelRightClose className="size-3.5" />
          </PanelIconButton>
        </header>

        <div className="relative min-h-0 flex-1 bg-panel">
          {!activeTab && !pendingTerminal && <EmptyUtilityPanelState onAdd={addTab} />}
          {browserTabs.map((tab) => (
            <BrowserTool
              key={tab.id}
              tab={tab}
              active={activeTab?.id === tab.id}
              onUpdate={(patch) => updateBrowserTab(tab.id, patch)}
            />
          ))}
          {activeTab?.tool === "files" && (
            <FilesTool
              tabs={visibleFileTabs}
              activePath={visibleActiveFilePath}
              loadingPath={visibleLoadingFilePath}
              onActivePathChange={setActiveFilePath}
              onLoadingPathChange={setLoadingFilePath}
              onOpenFileStart={startFileTab}
              onFileOpened={upsertFileTab}
              restoreActivePath={persistedFileState?.activePath ?? null}
              restorePaths={persistedFileState?.paths ?? []}
              openRequest={fileOpenRequest}
            />
          )}
          {terminalMounted && (
            <TerminalTool
              active={activeTab?.tool === "terminal"}
              activeTerminalId={activeTab?.terminalId ?? null}
              openRequest={terminalOpenRequest}
              command={terminalCommand}
              actionsHost={terminalActionsHost}
              onSessionUpsert={upsertTerminalTab}
              onSessionRemove={removeTerminalTab}
              onSessionsHydrate={hydrateTerminalTabs}
              onActiveTerminalChange={handleActiveTerminalChange}
              onCommandSettled={() => setTerminalCommand(null)}
            />
          )}
          {activeTab?.tool === "review" && (
            <PlaceholderTool
              icon={FileText}
              title="审阅"
              description="后续会汇总代码改动、权限请求和可审阅项。"
            />
          )}
          {activeTab?.tool === "side-chat" && (
            <PlaceholderTool
              icon={MessageCirclePlus}
              title="侧边聊天"
              description="后续会承接当前会话上下文，用来和主对话并行沟通。"
            />
          )}
        </div>
      </div>
      {addMenuOpen &&
        addMenuPosition &&
        createPortal(
          <AddTabMenu activeTab={activeTab} position={addMenuPosition} onAdd={addTab} />,
          document.body
        )}
    </aside>
  )
}

function EmptyUtilityPanelState({
  onAdd,
}: {
  onAdd: (tool: UtilityTool) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-8">
      <div className="w-full max-w-130">
        {toolOrder.map((tool) => {
          const Icon = toolMeta[tool].icon
          return (
            <button
              key={tool}
              type="button"
              onClick={() => onAdd(tool)}
              className="group flex h-12.5 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-ui-foreground transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Icon
                className="size-3.5 shrink-0 text-ui-muted transition-colors group-hover:text-ui-foreground"
                strokeWidth={1.8}
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">{toolMeta[tool].label}</span>
              {toolMeta[tool].shortcut && (
                <kbd className="rounded-md bg-code px-1.5 py-0.5 font-sans text-[11px] text-ui-muted">
                  {toolMeta[tool].shortcut}
                </kbd>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function UtilityTabButton({
  tab,
  active,
  loading,
  showSeparator,
  tabCount,
  rightCount,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
}: {
  tab: UtilityTab
  active: boolean
  loading?: boolean
  showSeparator: boolean
  tabCount: number
  rightCount: number
  onSelect: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
}): React.JSX.Element {
  const Icon = toolMeta[tab.tool].icon
  const TabIcon = tab.fileIcon ?? Icon

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={cn(
          "group relative flex h-8 max-w-42 min-w-28 flex-[1_1_10.5rem] items-center rounded-xl text-[12.5px] transition-colors",
          active
            ? "bg-muted/55 text-ui-foreground"
            : "text-ui-muted hover:bg-muted/35 hover:text-ui-foreground",
          showSeparator &&
            "after:absolute after:top-2 after:-right-0.5 after:h-4 after:w-px after:bg-border/55"
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl px-2.5 pr-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          title={tab.title}
        >
          <TabIcon
            className={cn("size-3.5 shrink-0", loading && "animate-pulse")}
            strokeWidth={1.8}
          />
          <span className="utility-tab-title relative min-w-0 flex-1 overflow-hidden text-[12px] whitespace-nowrap">
            {tab.title}
          </span>
        </button>
        <button
          type="button"
          aria-label="关闭标签"
          title="关闭标签"
          onClick={onClose}
          className={cn(
            "mr-1 grid size-5 shrink-0 place-items-center rounded-md text-ui-muted transition-opacity group-hover:opacity-100 hover:bg-background hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            active ? "opacity-75" : "opacity-0"
          )}
        >
          <X className="size-3.5" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={onClose}>关闭</ContextMenuItem>
        <ContextMenuItem disabled={tabCount <= 1} onClick={onCloseOthers}>
          关闭其他标签
        </ContextMenuItem>
        <ContextMenuItem disabled={rightCount === 0} onClick={onCloseRight}>
          关闭右侧标签
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function fileTabId(path: string, projectPath?: string): string {
  return `file-tab:${projectPath ?? "no-project"}:${path}`
}

function placeFileTab(current: UtilityTab[], fileTab: UtilityTab): UtilityTab[] {
  const existingIndex = current.findIndex((tab) => tab.id === fileTab.id)
  if (existingIndex >= 0) {
    return current.map((tab, index) =>
      index === existingIndex
        ? {
            ...tab,
            title: fileTab.title,
            fileIcon: fileTab.fileIcon ?? tab.fileIcon,
            fileType: fileTab.fileType ?? tab.fileType,
            filePath: fileTab.filePath,
            projectPath: fileTab.projectPath,
          }
        : tab
    )
  }

  const emptyIndex = current.findIndex((tab) => tab.id === filesTabId)
  if (emptyIndex >= 0) {
    return current.map((tab, index) => (index === emptyIndex ? fileTab : tab))
  }

  return [...current, fileTab]
}

function toolTabId(tool: UtilityTool): string {
  return tool === "files" ? filesTabId : `${tool}-tab`
}

function terminalTabId(terminalId: string): string {
  return `terminal-tab:${terminalId}`
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function toRelativeWorkspacePath(path: string, projectPath: string | undefined): string | null {
  const withoutLocation = path.trim().replace(/:(\d+)(?::\d+)?$/, "")
  const normalizedPath = withoutLocation.replace(/\\/g, "/")
  const normalizedProject = projectPath?.replace(/\\/g, "/").replace(/\/$/, "")
  if (/^[a-z]:\//i.test(normalizedPath)) {
    if (!normalizedProject) return null
    const projectPrefix = `${normalizedProject.toLocaleLowerCase()}/`
    if (!normalizedPath.toLocaleLowerCase().startsWith(projectPrefix)) return null
    return normalizedPath.slice(normalizedProject.length + 1)
  }
  return normalizedPath.replace(/^\.\//, "").replace(/^\//, "")
}

function readPersistedFileTabs(): PersistedFileTabState {
  try {
    const raw = localStorage.getItem(persistedFileTabsKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const result: PersistedFileTabState = {}
    for (const [projectPath, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const paths = Array.isArray(record.paths)
        ? record.paths.filter((path): path is string => typeof path === "string")
        : []
      const activePath = typeof record.activePath === "string" ? record.activePath : null
      if (paths.length > 0) result[projectPath] = { activePath, paths }
    }
    return result
  } catch {
    return {}
  }
}

function writePersistedFileTabs(state: PersistedFileTabState): void {
  try {
    localStorage.setItem(persistedFileTabsKey, JSON.stringify(state))
  } catch {
    // Ignore storage quota and private-mode failures; file tabs are recoverable UI state.
  }
}

function AddTabMenu({
  activeTab,
  position,
  onAdd,
}: {
  activeTab?: UtilityTab
  position: MenuPosition
  onAdd: (tool: UtilityTool) => void
}): React.JSX.Element {
  return (
    <div
      className="fixed z-[80] w-80 rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg"
      style={{ left: position.left, top: position.top }}
    >
      {toolOrder.map((tool) => {
        const Icon = toolMeta[tool].icon
        const disabled = tool !== "browser" && tool !== "terminal" && activeTab?.tool === tool
        return (
          <button
            key={tool}
            type="button"
            disabled={disabled}
            onClick={() => onAdd(tool)}
            className="flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-45"
          >
            <Icon className="size-4 text-ui-muted" strokeWidth={1.8} />
            <span>{toolMeta[tool].label}</span>
            {toolMeta[tool].shortcut && (
              <kbd className="ml-auto rounded bg-code px-1.5 py-0.5 font-sans text-[11px] text-ui-muted">
                {toolMeta[tool].shortcut}
              </kbd>
            )}
          </button>
        )
      })}
    </div>
  )
}

function PanelIconButton({
  label,
  pressed,
  onClick,
  subtle,
  children,
}: {
  label: string
  pressed?: boolean
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  subtle?: boolean
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
        "grid shrink-0 place-items-center rounded-md text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[pressed=true]:bg-muted [&_svg]:size-4",
        subtle ? "size-7" : "size-8 bg-muted/55"
      )}
      data-pressed={pressed}
    >
      {children}
    </button>
  )
}
