import {
  BookOpenText,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  FileCode2,
  FilePlus2,
  FolderOpen,
  Loader2,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  Search,
  TerminalSquare,
  X,
  type LucideIcon,
} from "lucide-react"
import type * as React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { prepareFileTreeInput, type ContextMenuItem } from "@pierre/trees"
import { FileTree, useFileTree } from "@pierre/trees/react"
import { Group, Panel, usePanelRef } from "react-resizable-panels"

import {
  FileViewer,
  type FileSearchMatch,
  type FileViewMode,
  type FileViewerTab,
} from "@renderer/components/desktop/tools/file-viewer"
import { isMarkdownPath } from "@renderer/components/desktop/tools/file-icons"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import type {
  WorkspaceFileEntry,
  WorkspaceListFilesResult,
  WorkspaceReadFileResult,
} from "@shared/workspace-types"

type LoadState = "idle" | "loading" | "ready" | "error"
type FileTreeAction = "reveal" | "copy-relative" | "copy-absolute" | "add-to-chat"

const fileTreeDefaultWidth = 300
const fileTreeMinimumWidth = 220
const resizeTargetMinimumSize = { fine: 12, coarse: 28 }

type FilesToolProps = {
  tabs: FileViewerTab[]
  activePath: string | null
  loadingPath: string | null
  onActivePathChange: (path: string | null) => void
  onLoadingPathChange: React.Dispatch<React.SetStateAction<string | null>>
  onOpenFileStart: (path: string) => void
  onFileOpened: (tab: FileViewerTab) => void
  restoreActivePath: string | null
  restorePaths: string[]
  openRequest: { id: number; path: string; line?: number } | null
}

export function FilesTool({
  tabs,
  activePath,
  loadingPath,
  onActivePathChange,
  onLoadingPathChange,
  onOpenFileStart,
  onFileOpened,
  restoreActivePath,
  restorePaths,
  openRequest,
}: FilesToolProps): React.JSX.Element {
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const [loadState, setLoadState] = useState<LoadState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [listing, setListing] = useState<WorkspaceListFilesResult | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [viewModeByPath, setViewModeByPath] = useState<Record<string, FileViewMode>>({})
  const [treeOpen, setTreeOpen] = useState(true)
  const treePanelRef = usePanelRef()
  const restoredProjectRef = useRef<string | null>(null)
  const handledOpenRequestRef = useRef<number | null>(null)

  const fileEntries = useMemo(() => {
    const map = new Map<string, WorkspaceFileEntry>()
    for (const entry of listing?.entries ?? []) map.set(entry.path.replace(/\/$/, ""), entry)
    return map
  }, [listing])
  const treePaths = useMemo(() => listing?.entries.map((entry) => entry.path) ?? [], [listing])
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.preview.path === activePath) ?? null,
    [activePath, tabs]
  )
  const activeIsMarkdown = activeTab?.type === "markdown"
  const activeViewMode: FileViewMode =
    activeIsMarkdown && activePath ? (viewModeByPath[activePath] ?? "preview") : "source"
  const searchMatches = useMemo(
    () => findSearchMatches(activeTab?.preview.content ?? "", searchQuery),
    [activeTab?.preview.content, searchQuery]
  )
  const visibleSearchIndex =
    searchMatches.length === 0 ? -1 : Math.min(searchIndex, searchMatches.length - 1)

  const loadFiles = async (): Promise<void> => {
    if (!selectedProject?.path) {
      setListing(null)
      setLoadState("idle")
      return
    }

    setLoadState("loading")
    setError(null)
    try {
      const result = await window.desktop.workspace.listFiles({ rootPath: selectedProject.path })
      setListing(result)
      setLoadState("ready")
    } catch (loadError) {
      setError(errorMessage(loadError))
      setLoadState("error")
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadFiles()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [selectedProject?.path])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const wantsFind = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f"
      if (wantsFind) {
        event.preventDefault()
        if (activeTab?.preview.content) setSearchOpen(true)
        return
      }

      if (event.key === "Escape" && searchOpen) {
        event.preventDefault()
        setSearchOpen(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activeTab?.preview.content, searchOpen])

  const openFile = async (path: string): Promise<void> => {
    if (!selectedProject?.path) return
    const normalizedPath = path.replace(/\/$/, "")
    const entry = fileEntries.get(normalizedPath)
    if (!entry || entry.type !== "file") return

    onActivePathChange(normalizedPath)
    onOpenFileStart(normalizedPath)
    onLoadingPathChange(normalizedPath)
    setError(null)
    try {
      const result = await window.desktop.workspace.readFile({
        rootPath: selectedProject.path,
        path: normalizedPath,
      })
      onFileOpened(toFileViewerTab(result))
    } catch (readError) {
      setError(errorMessage(readError))
    } finally {
      onLoadingPathChange((current) => (current === normalizedPath ? null : current))
    }
  }

  useEffect(() => {
    if (!openRequest || loadState !== "ready" || handledOpenRequestRef.current === openRequest.id)
      return
    const path = toProjectRelativePath(openRequest.path, selectedProject?.path)
    handledOpenRequestRef.current = openRequest.id
    const timer = window.setTimeout(() => {
      if (path) void openFile(path)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fileEntries, loadState, openRequest, selectedProject?.path])

  async function restoreOpenFiles(): Promise<void> {
    if (!selectedProject?.path) return
    const existingPaths = restorePaths
      .map((path) => path.replace(/\/$/, ""))
      .filter((path) => fileEntries.get(path)?.type === "file")
      .slice(0, 12)
    if (existingPaths.length === 0) return

    const activeRestorePath =
      restoreActivePath && existingPaths.includes(restoreActivePath)
        ? restoreActivePath
        : existingPaths[0]
    const orderedPaths = [
      ...existingPaths.filter((path) => path !== activeRestorePath),
      activeRestorePath,
    ]

    for (const path of orderedPaths) {
      onOpenFileStart(path)
      onLoadingPathChange(path)
      try {
        const result = await window.desktop.workspace.readFile({
          rootPath: selectedProject.path,
          path,
        })
        onFileOpened(toFileViewerTab(result))
      } catch (restoreError) {
        setError(errorMessage(restoreError))
      } finally {
        onLoadingPathChange((current) => (current === path ? null : current))
      }
    }
  }

  useEffect(() => {
    if (
      loadState !== "ready" ||
      !selectedProject?.path ||
      restoredProjectRef.current === selectedProject.path ||
      tabs.length > 0 ||
      restorePaths.length === 0
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      restoredProjectRef.current = selectedProject.path
      void restoreOpenFiles()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadState, selectedProject?.path, restoreActivePath, restorePaths, tabs.length])

  const toggleTree = (): void => {
    const panel = treePanelRef.current
    if (!panel) {
      setTreeOpen((current) => !current)
      return
    }

    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }

  const setActiveViewMode = (mode: FileViewMode): void => {
    if (!activePath) return
    setViewModeByPath((current) => ({ ...current, [activePath]: mode }))
  }

  const moveSearchMatch = (direction: -1 | 1): void => {
    if (searchMatches.length === 0) return
    if (activeIsMarkdown && activeViewMode === "preview") setActiveViewMode("source")
    setSearchIndex((current) => {
      const safeCurrent = Math.max(0, Math.min(current, searchMatches.length - 1))
      return (safeCurrent + direction + searchMatches.length) % searchMatches.length
    })
  }

  if (!selectedProject) {
    return (
      <EmptyFilesState
        icon={FolderOpen}
        title="没有选中项目"
        description="在起始页或左侧栏选择项目后，这里会显示资源管理器。"
      />
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/45 px-2.5">
        <FileBreadcrumb projectName={selectedProject.name} path={activePath ?? "/"} />
        {activeIsMarkdown && (
          <button
            type="button"
            aria-label={activeViewMode === "preview" ? "查看 Markdown 源码" : "预览 Markdown"}
            title={activeViewMode === "preview" ? "查看 Markdown 源码" : "预览 Markdown"}
            onClick={() => setActiveViewMode(activeViewMode === "preview" ? "source" : "preview")}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-ui-muted hover:bg-muted hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[active=true]:bg-muted data-[active=true]:text-ui-foreground [&_svg]:size-4"
            data-active={activeViewMode === "preview"}
          >
            {activeViewMode === "preview" ? <Code2 /> : <BookOpenText />}
          </button>
        )}
        <button
          type="button"
          aria-label={treeOpen ? "收起文件树" : "展开文件树"}
          title={treeOpen ? "收起文件树" : "展开文件树"}
          onClick={toggleTree}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-ui-muted hover:bg-muted hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
        >
          {treeOpen ? <PanelRightClose /> : <PanelRight />}
        </button>
        <button
          type="button"
          aria-label="刷新文件树"
          title="刷新文件树"
          onClick={() => void loadFiles()}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-ui-muted hover:bg-muted hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
        >
          <RefreshCw />
        </button>
      </div>

      {loadState === "loading" && (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-ui-muted">
          <Loader2 className="size-4 animate-spin" />
          正在读取项目文件...
        </div>
      )}

      {loadState === "error" && (
        <EmptyFilesState
          icon={FileCode2}
          title="无法读取项目"
          description={error ?? "请稍后重试。"}
        />
      )}

      {loadState === "ready" && listing && (
        <Group
          id="desktop-files-tool"
          orientation="horizontal"
          className="min-h-0 flex-1"
          resizeTargetMinimumSize={resizeTargetMinimumSize}
        >
          <Panel
            id="file-preview"
            minSize={280}
            className="relative min-h-0 min-w-0 overflow-hidden"
          >
            {searchOpen && (
              <div className="absolute top-3 right-3 z-40">
                <FileSearchControls
                  query={searchQuery}
                  matchCount={searchMatches.length}
                  matchIndex={visibleSearchIndex}
                  disabled={!activeTab?.preview.content}
                  onQueryChange={(query) => {
                    setSearchQuery(query)
                    setSearchIndex(0)
                  }}
                  onPrevious={() => moveSearchMatch(-1)}
                  onNext={() => moveSearchMatch(1)}
                  onClose={() => setSearchOpen(false)}
                />
              </div>
            )}
            <FileViewer
              tabs={tabs}
              activePath={activePath}
              loadingPath={loadingPath}
              viewMode={activeViewMode}
              searchQuery={searchQuery}
              searchMatchIndex={visibleSearchIndex}
              searchMatches={searchMatches}
              targetLine={
                openRequest &&
                toProjectRelativePath(openRequest.path, selectedProject?.path) === activePath
                  ? openRequest.line
                  : undefined
              }
            />
          </Panel>

          {treeOpen ? <PanelResizeHandle label="调整文件树宽度" /> : null}

          <Panel
            id="file-tree"
            panelRef={treePanelRef}
            defaultSize={fileTreeDefaultWidth}
            minSize={fileTreeMinimumWidth}
            maxSize="45%"
            collapsedSize={0}
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            className="min-h-0 overflow-hidden border-l border-border/45"
            onResize={(size) => {
              const nextOpen = size.inPixels > 1
              setTreeOpen((current) => (current === nextOpen ? current : nextOpen))
            }}
          >
            <div className="flex h-full min-h-0 flex-col">
              <ProjectFileTree
                rootPath={selectedProject.path}
                paths={treePaths}
                selectedPath={activePath}
                onSelect={(path) => void openFile(path)}
                onActionError={(actionError) => setError(errorMessage(actionError))}
              />
              {listing.truncated && (
                <p className="shrink-0 border-t border-border/45 px-3 py-2 text-[11px] text-ui-muted">
                  文件较多，仅显示前 5000 项。
                </p>
              )}
            </div>
          </Panel>
        </Group>
      )}
    </section>
  )
}

function FileBreadcrumb({
  projectName,
  path,
}: {
  projectName: string
  path: string
}): React.JSX.Element {
  const normalizedPath = path.trim() || "/"
  const segments = normalizedPath === "/" ? [] : normalizedPath.split("/").filter(Boolean)

  return (
    <nav
      aria-label="文件路径"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[13px] text-ui-muted"
    >
      <span className="max-w-40 shrink-0 truncate text-ui-foreground" title={projectName}>
        {projectName}
      </span>
      {segments.length === 0 ? (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-ui-muted/70" strokeWidth={1.8} />
          <span className="font-medium text-ui-foreground">/</span>
        </>
      ) : (
        segments.map((segment, index) => {
          const last = index === segments.length - 1
          return (
            <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0 text-ui-muted/70" strokeWidth={1.8} />
              <span
                className={last ? "truncate font-semibold text-ui-foreground" : "truncate"}
                title={segment}
              >
                {segment}
              </span>
            </span>
          )
        })
      )}
    </nav>
  )
}

function ProjectFileTree({
  rootPath,
  paths,
  selectedPath,
  onSelect,
  onActionError,
}: {
  rootPath: string
  paths: string[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onActionError: (error: unknown) => void
}): React.JSX.Element {
  const preparedInput = useMemo(
    () => prepareFileTreeInput(paths, { flattenEmptyDirectories: true }),
    [paths]
  )
  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    fileTreeSearchMode: "hide-non-matches",
    initialExpansion: "closed",
    initialVisibleRowCount: 36,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    overscan: 18,
    preparedInput,
    search: true,
    stickyFolders: true,
    onSelectionChange: (selectedPaths) => {
      const nextPath = selectedPaths[0]
      if (nextPath) onSelect(nextPath)
    },
    unsafeCSS: `
      :host {
        --trees-bg-override: var(--panel);
        --trees-bg-muted-override: var(--muted);
        --trees-border-color-override: color-mix(in oklab, var(--border) 62%, transparent);
        --trees-fg-override: var(--ui-foreground);
        --trees-fg-muted-override: var(--ui-muted);
        --trees-focus-ring-color-override: var(--ring);
        --trees-indent-guide-bg-override: color-mix(in oklab, var(--ui-muted) 22%, transparent);
        --trees-input-bg-override: color-mix(in oklab, var(--panel) 96%, var(--foreground) 4%);
        --trees-padding-inline-override: 8px;
        --trees-scrollbar-gutter-override: 7px;
        --trees-scrollbar-thumb-override: color-mix(in oklab, var(--ui-muted) 34%, transparent);
        --trees-search-fg-override: var(--ui-foreground);
        --trees-selected-bg-override: var(--sidebar-selected);
        --trees-selected-fg-override: var(--foreground);
        font-family: var(--font-sans);
        --trees-font-family-override: var(--font-sans);
        --trees-font-size-override: 12.5px;
        --trees-font-weight-regular-override: 450;
        --trees-item-padding-x-override: 7px;
      }

      [data-type="item"] {
        transition: background-color 120ms ease, color 120ms ease;
      }

      [data-type="item"][data-item-selected="true"] {
        font-weight: 520;
      }

      [data-file-tree-search-input] {
        box-shadow: none;
      }
    `,
  })

  useEffect(() => {
    model.resetPaths({ preparedInput, initialExpandedPaths: [] })
  }, [model, preparedInput])

  const handleContextAction = async (
    action: FileTreeAction,
    item: ContextMenuItem
  ): Promise<void> => {
    try {
      if (action === "reveal") {
        await window.desktop.workspace.revealPath({ rootPath, path: item.path })
        return
      }

      if (action === "copy-relative") {
        await window.desktop.workspace.copyPath({ rootPath, path: item.path })
        return
      }

      if (action === "copy-absolute") {
        await window.desktop.workspace.copyPath({ rootPath, path: item.path, absolute: true })
        return
      }

      window.dispatchEvent(
        new CustomEvent("desktop:add-to-composer", {
          detail: { text: formatFileMention(item) },
        })
      )
    } catch (error) {
      onActionError(error)
    }
  }

  return (
    <FileTree
      model={model}
      renderContextMenu={(item, context) => (
        <FileTreeContextMenu
          item={item}
          onAction={(action) => {
            context.close()
            void handleContextAction(action, item)
          }}
        />
      )}
      style={{ height: "100%" }}
    />
  )
}

function FileTreeContextMenu({
  item,
  onAction,
}: {
  item: ContextMenuItem
  onAction: (action: FileTreeAction) => void
}): React.JSX.Element {
  return (
    <div
      data-file-tree-context-menu-root="true"
      className="w-64 rounded-xl border border-border/55 bg-popover p-1.5 text-[13px] text-popover-foreground shadow-xl shadow-black/12 dark:border-white/8 dark:shadow-black/40"
    >
      <FileTreeMenuButton icon={FolderOpen} onClick={() => onAction("reveal")}>
        在 File Explorer 中打开
      </FileTreeMenuButton>

      <div className="group/open-with relative">
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4 [&_svg]:shrink-0"
        >
          <Code2 className="text-ui-muted" strokeWidth={1.8} />
          <span className="min-w-0 flex-1">打开方式</span>
          <ChevronRight className="text-ui-muted" strokeWidth={1.8} />
        </button>
        <div className="invisible absolute top-0 left-[calc(100%-2px)] w-56 rounded-xl border border-border/55 bg-popover p-1.5 opacity-0 shadow-xl shadow-black/12 transition-[opacity,visibility] group-hover/open-with:visible group-hover/open-with:opacity-100 dark:border-white/8 dark:shadow-black/40">
          <FileTreeMenuButton icon={Code2} disabled>
            VS Code
          </FileTreeMenuButton>
          <FileTreeMenuButton icon={Code2} disabled>
            Cursor
          </FileTreeMenuButton>
          <FileTreeMenuButton icon={TerminalSquare} disabled>
            Terminal
          </FileTreeMenuButton>
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-ui-muted">后续接入应用路径和终端配置</p>
        </div>
      </div>

      <div className="my-1 h-px bg-border/45" />

      <FileTreeMenuButton icon={Copy} onClick={() => onAction("copy-relative")}>
        复制相对路径
      </FileTreeMenuButton>
      <FileTreeMenuButton icon={Copy} onClick={() => onAction("copy-absolute")}>
        复制完整路径
      </FileTreeMenuButton>
      <FileTreeMenuButton icon={FilePlus2} onClick={() => onAction("add-to-chat")}>
        添加到聊天
      </FileTreeMenuButton>

      <div className="mt-1 border-t border-border/45 px-2.5 pt-2 pb-1 text-[11px] text-ui-muted">
        {item.kind === "directory" ? "文件夹" : "文件"} · {item.name}
      </div>
    </div>
  )
}

function FileTreeMenuButton({
  icon: Icon,
  disabled,
  onClick,
  children,
}: {
  icon: LucideIcon
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ui-muted"
    >
      <Icon strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

function formatFileMention(item: ContextMenuItem): string {
  const path = item.kind === "directory" ? item.path.replace(/\/$/, "") : item.path
  return item.kind === "directory" ? `@${path}/` : `@${path}`
}

function EmptyFilesState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <Icon className="mb-4 size-9 text-ui-muted" strokeWidth={1.6} />
      <h2 className="text-[17px] font-semibold text-ui-foreground">{title}</h2>
      <p className="mt-2 max-w-72 text-[13px] leading-6 text-ui-muted">{description}</p>
    </div>
  )
}

function FileSearchControls({
  query,
  matchCount,
  matchIndex,
  disabled,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: {
  query: string
  matchCount: number
  matchIndex: number
  disabled: boolean
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hasQuery = query.trim().length > 0
  const canNavigate = hasQuery && matchCount > 0

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="flex h-12 min-w-0 shrink-0 items-center rounded-xl border border-border/70 bg-popover px-2 text-ui-muted shadow-lg shadow-black/12 dark:border-white/12 dark:shadow-black/35">
      <Search className="ml-0.5 size-4 shrink-0" strokeWidth={1.8} />
      <input
        ref={inputRef}
        value={query}
        disabled={disabled}
        placeholder="搜索当前文件"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            if (!canNavigate) return
            if (event.shiftKey) {
              onPrevious()
            } else {
              onNext()
            }
            return
          }

          if (event.key === "Escape") {
            event.preventDefault()
            onClose()
          }
        }}
        className="h-full w-52 min-w-0 bg-transparent px-2 text-[13px] text-ui-foreground placeholder:text-ui-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
      />
      {hasQuery && (
        <span className="shrink-0 px-2 text-[12px] text-ui-muted tabular-nums">
          {matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : "No results"}
        </span>
      )}
      <button
        type="button"
        aria-label="上一个搜索结果"
        title="上一个搜索结果"
        disabled={!canNavigate}
        onClick={onPrevious}
        className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-muted hover:text-ui-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-4"
      >
        <ChevronUp />
      </button>
      <button
        type="button"
        aria-label="下一个搜索结果"
        title="下一个搜索结果"
        disabled={!canNavigate}
        onClick={onNext}
        className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-muted hover:text-ui-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-4"
      >
        <ChevronDown />
      </button>
      <button
        type="button"
        aria-label="关闭搜索"
        title="关闭搜索"
        onClick={onClose}
        className="-mt-9 -mr-4 ml-1 grid size-7 shrink-0 place-items-center rounded-full bg-ui-muted text-popover hover:bg-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
      >
        <X />
      </button>
    </div>
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  return String(error)
}

function toProjectRelativePath(path: string, projectPath: string | undefined): string | null {
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

function toFileViewerTab(preview: WorkspaceReadFileResult): FileViewerTab {
  return {
    preview,
    type: isMarkdownPath(preview.path) ? "markdown" : isDocumentFile(preview) ? "document" : "code",
  }
}

function isDocumentFile(preview: WorkspaceReadFileResult): boolean {
  const extension = preview.name.split(".").pop()?.toLowerCase()
  return Boolean(
    preview.binary ||
    preview.content === null ||
    extension === "pdf" ||
    extension === "doc" ||
    extension === "docx" ||
    extension === "xls" ||
    extension === "xlsx" ||
    extension === "ppt" ||
    extension === "pptx"
  )
}

function findSearchMatches(content: string, query: string): FileSearchMatch[] {
  const needle = query.trim()
  if (!content || !needle) return []

  const lowerContent = content.toLocaleLowerCase()
  const lowerNeedle = needle.toLocaleLowerCase()
  const matches: FileSearchMatch[] = []
  let line = 0
  let lineStart = 0
  let index = lowerContent.indexOf(lowerNeedle)

  while (index !== -1 && matches.length < 1000) {
    while (lineStart <= index) {
      const nextNewline = content.indexOf("\n", lineStart)
      if (nextNewline === -1 || nextNewline >= index) break
      line += 1
      lineStart = nextNewline + 1
    }

    matches.push({ index, line, column: index - lineStart })
    index = lowerContent.indexOf(lowerNeedle, index + lowerNeedle.length)
  }

  return matches
}
