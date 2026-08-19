import { DEFAULT_THEMES, type FileContents } from "@pierre/diffs"
import { File as PierreFile, type FileOptions } from "@pierre/diffs/react"
import { FileCode2, FileText } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Streamdown } from "streamdown"

import { streamdownComponents } from "@renderer/components/desktop/conversation-page/message/streamdown-components"
import { streamdownPlugins } from "@renderer/components/desktop/conversation-page/message/streamdown-plugins"
import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

export type FileViewMode = "preview" | "source"

export interface FileSearchMatch {
  index: number
  line: number
  column: number
}

export interface FileViewerTab {
  preview: WorkspaceReadFileResult
  type: "code" | "document" | "markdown"
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

const codeViewerOptions: FileOptions<undefined> = {
  disableFileHeader: true,
  overflow: "scroll",
  theme: DEFAULT_THEMES,
  tokenizeMaxLength: 220_000,
  tokenizeMaxLineLength: 20_000,
  unsafeCSS: `
    :host {
      display: block;
      min-width: max-content;
      background: transparent;
      color: var(--content-foreground);
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 20px;
    }

    pre {
      margin: 0;
      min-width: max-content;
      background: transparent !important;
      font-family: var(--font-mono) !important;
      font-size: 12px !important;
      line-height: 20px !important;
    }
  `,
}

const codeLineHeight = 20

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
          <CodePreview
            preview={activeTab.preview}
            themeType={themeType}
            searchQuery={searchQuery}
            searchMatch={searchMatches[searchMatchIndex]}
            targetLine={targetLine}
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

function CodePreview({
  preview,
  themeType,
  searchQuery,
  searchMatch,
  targetLine,
}: {
  preview: WorkspaceReadFileResult
  themeType: "dark" | "light"
  searchQuery: string
  searchMatch?: FileSearchMatch
  targetLine?: number
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const file = useMemo<FileContents>(
    () => ({
      name: preview.path,
      contents: preview.content ?? "",
      lang: normalizeLanguage(preview.language, preview.path),
      cacheKey: `${preview.path}:${preview.size}`,
    }),
    [preview.content, preview.language, preview.path, preview.size]
  )

  useEffect(() => {
    if (!searchQuery || !searchMatch || !viewportRef.current) return
    const targetTop = Math.max(0, searchMatch.line * codeLineHeight - 72)
    viewportRef.current.scrollTo({ top: targetTop, behavior: "smooth" })
  }, [preview.path, searchMatch, searchQuery])

  useEffect(() => {
    if (!targetLine || !viewportRef.current) return
    const targetTop = Math.max(0, (targetLine - 1) * codeLineHeight - 72)
    viewportRef.current.scrollTo({ top: targetTop, behavior: "smooth" })
  }, [preview.path, targetLine])

  const currentLineTop =
    searchQuery && searchMatch
      ? searchMatch.line * codeLineHeight
      : targetLine
        ? (targetLine - 1) * codeLineHeight
        : null

  return (
    <ScrollArea
      className="h-full min-w-0"
      viewportClassName="p-0"
      contentClassName="min-w-max"
      viewportRef={viewportRef}
    >
      <div className="relative min-h-full min-w-max">
        {currentLineTop !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 z-0 h-5 min-w-full bg-amber-200/28 ring-1 ring-amber-300/30 dark:bg-amber-300/12 dark:ring-amber-200/10"
            style={{ top: currentLineTop }}
          />
        )}
        <PierreFile
          key={file.cacheKey}
          file={file}
          options={{ ...codeViewerOptions, themeType }}
          className="desktop-code-file relative z-10 min-w-max"
        />
      </div>
    </ScrollArea>
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

function normalizeLanguage(language: string, path: string): FileContents["lang"] | undefined {
  const normalized = languageFromPath(path) ?? language.toLowerCase()
  if (!normalized || normalized === "text") return undefined

  const languageMap: Record<string, FileContents["lang"]> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    csharp: "csharp",
    css: "css",
    cts: "typescript",
    dockerfile: "docker",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsonc: "jsonc",
    jsx: "jsx",
    kt: "kotlin",
    less: "less",
    lua: "lua",
    md: "markdown",
    mdx: "mdx",
    mjs: "javascript",
    mts: "typescript",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svelte: "svelte",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  }

  return languageMap[normalized] ?? (normalized as FileContents["lang"])
}

function languageFromPath(path: string): string | null {
  const name = path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? path.toLowerCase()
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "dockerfile"
  const extension = name.split(".").pop()
  return extension && extension !== name ? extension : null
}
