/* eslint-disable react-refresh/only-export-components */
import { FileCode2, FileText } from "lucide-react"
import { useEffect, useState } from "react"
import { Streamdown } from "streamdown"

import { streamdownComponents } from "@renderer/components/desktop/conversation-page/message/streamdown-components"
import { streamdownPlugins } from "@renderer/components/desktop/conversation-page/message/streamdown-plugins"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

import { VirtualizedCodePreview } from "./virtualized-code-preview"

export type FileViewMode = "preview" | "source"

export interface FileSearchMatch {
  index: number
  line: number
  column: number
}

export interface FileViewerTab {
  preview: WorkspaceReadFileResult
  type: "code" | "document" | "markdown"
  projectPath?: string | null
}

export function mergeFileViewerTabs(
  current: FileViewerTab[],
  nextFileTab: FileViewerTab,
  projectPath: string | null
): FileViewerTab[] {
  const nextTab = { ...nextFileTab, projectPath }
  return [
    nextTab,
    ...current.filter(
      (tab) =>
        (tab.projectPath ?? null) === projectPath && tab.preview.path !== nextTab.preview.path
    ),
  ]
}

interface FileViewerProps {
  tabs: FileViewerTab[]
  activePath: string | null
  loadingPath: string | null
  viewMode: FileViewMode
  searchQuery: string
  searchMatchIndex: number
  searchMatches: FileSearchMatch[]
  targetLine?: number
}

export function FileViewer({
  tabs,
  activePath,
  loadingPath,
  viewMode,
  searchQuery,
  searchMatchIndex,
  searchMatches,
  targetLine,
}: FileViewerProps): React.JSX.Element {
  const [themeType, setThemeType] = useThemeType()
  const [forcedHighlightPaths, setForcedHighlightPaths] = useState<Set<string>>(() => new Set())
  const activeTab = tabs.find((tab) => tab.preview.path === activePath) ?? null

  useEffect(() => {
    const update = (): void => setThemeType(resolveThemeType())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [setThemeType])

  if (tabs.length === 0 && !loadingPath) {
    return (
      <DesktopEmptyState
        icon={FileCode2}
        title="选择文件以预览"
        description="打开的文件会在顶部标签页里保留。"
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="min-h-0 min-w-0 flex-1">
        {loadingPath && loadingPath === activePath ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ui-muted">
            <Spinner />
            正在读取文件...
          </div>
        ) : activeTab?.type === "document" ? (
          <DocumentPlaceholder preview={activeTab.preview} />
        ) : activeTab?.type === "markdown" && viewMode === "preview" ? (
          <MarkdownPreview preview={activeTab.preview} />
        ) : activeTab ? (
          <VirtualizedCodePreview
            key={activeTab.preview.path}
            preview={activeTab.preview}
            themeType={themeType}
            searchQuery={searchQuery}
            searchMatch={searchMatches[searchMatchIndex]}
            targetLine={targetLine}
            forceHighlight={forcedHighlightPaths.has(activeTab.preview.path)}
            onForceHighlight={() => {
              setForcedHighlightPaths((current) => {
                const next = new Set(current)
                next.add(activeTab.preview.path)
                return next
              })
            }}
          />
        ) : (
          <DesktopEmptyState
            icon={FileCode2}
            title="选择文件以预览"
            description="打开的文件会在顶部标签页里保留。"
          />
        )}
      </div>
    </div>
  )
}

function MarkdownPreview({ preview }: { preview: WorkspaceReadFileResult }): React.JSX.Element {
  return (
    <ScrollArea className="h-full min-w-0" viewportClassName="p-0">
      <article className="desktop-markdown-preview mx-auto min-h-full w-full max-w-[920px] px-8 py-8 text-[13.5px] leading-7 text-content-foreground">
        <Streamdown
          mode="static"
          controls={false}
          lineNumbers
          plugins={streamdownPlugins}
          components={streamdownComponents}
          className="desktop-streamdown"
        >
          {preview.content ?? ""}
        </Streamdown>
      </article>
    </ScrollArea>
  )
}

function DocumentPlaceholder({ preview }: { preview: WorkspaceReadFileResult }): React.JSX.Element {
  return (
    <DesktopEmptyState
      icon={FileText}
      title={preview.name}
      description="这类文件的预览后续接入，这里先保留标签页占位。"
    />
  )
}

function useThemeType(): ["dark" | "light", (value: "dark" | "light") => void] {
  return useState<"dark" | "light">(() => resolveThemeType())
}

function resolveThemeType(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}
