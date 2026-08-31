import { DEFAULT_THEMES } from "@pierre/diffs"
import {
  File as PierreFile,
  type FileOptions,
  Virtualizer,
  useVirtualizer,
} from "@pierre/diffs/react"
import { useEffect, useMemo } from "react"

import { LargePreviewNotice } from "./large-preview-notice"
import { previewLimits, resolvePreviewDecision, type PreviewDecision } from "./file-preview-policy"
import {
  createPreviewFile,
  resolveActiveLineIndex,
  resolveCodeRenderMode,
  resolvePreviewScrollTop,
} from "./virtualized-code-preview-model"
import type { FileSearchMatch } from "./file-viewer"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

interface VirtualizedCodePreviewProps {
  preview: WorkspaceReadFileResult
  themeType: "dark" | "light"
  searchQuery: string
  searchMatch?: FileSearchMatch
  targetLine?: number
  forceHighlight: boolean
  onForceHighlight: () => void
}

const codeLineHeight = 20
const virtualizerConfig = { overscrollSize: 800 }
const codeViewerCSS = `
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
`

export function VirtualizedCodePreview({
  preview,
  themeType,
  searchQuery,
  searchMatch,
  targetLine,
  forceHighlight,
  onForceHighlight,
}: VirtualizedCodePreviewProps): React.JSX.Element {
  const content = preview.content ?? ""
  const decision = useMemo(() => resolvePreviewDecision("file", content), [content])
  const mode = resolveCodeRenderMode(decision, forceHighlight)
  const file = useMemo(() => createPreviewFile(preview, mode), [mode, preview])
  const options = useMemo<FileOptions<undefined>>(
    () => ({
      disableFileHeader: true,
      overflow: "scroll",
      preferredHighlighter: "shiki-js",
      theme: DEFAULT_THEMES,
      themeType,
      tokenizeMaxLength: previewLimits.file.lines,
      tokenizeMaxLineLength: previewLimits.file.lineLength,
      unsafeCSS: codeViewerCSS,
    }),
    [themeType]
  )
  const searchLine = searchQuery && searchMatch ? searchMatch.line : undefined
  const scrollTop = resolvePreviewScrollTop({ searchLine, targetLine })
  const activeLineIndex = resolveActiveLineIndex({ searchLine, targetLine })

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {decision.mode === "plain" && !forceHighlight ? (
        <LargePreviewNotice
          title="文件较大，已关闭语法高亮"
          description={describeDecision(decision)}
          primaryLabel="仍然高亮"
          onPrimary={onForceHighlight}
        />
      ) : null}
      <Virtualizer
        className="h-full min-h-0 min-w-0 flex-1 overflow-auto"
        contentClassName="relative min-h-full min-w-max"
        config={virtualizerConfig}
      >
        <PreviewScrollController top={scrollTop} />
        {activeLineIndex !== null ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 z-0 h-5 min-w-full bg-amber-200/28 ring-1 ring-amber-300/30 dark:bg-amber-300/12 dark:ring-amber-200/10"
            style={{ top: activeLineIndex * codeLineHeight }}
          />
        ) : null}
        <PierreFile
          file={file}
          options={options}
          className="desktop-code-file relative z-10 min-w-max"
        />
      </Virtualizer>
    </div>
  )
}

function PreviewScrollController({ top }: { top: number | null }): null {
  const virtualizer = useVirtualizer()

  useEffect(() => {
    if (top === null) return
    virtualizer?.scrollTo({ top, behavior: "smooth" })
  }, [top, virtualizer])

  return null
}

function describeDecision(decision: PreviewDecision): string {
  const reason =
    decision.reason === "characters"
      ? "内容长度超过高亮上限"
      : decision.reason === "lines"
        ? "文件行数超过高亮上限"
        : "存在过长单行"
  return `${reason}；${decision.metrics.characterCount.toLocaleString()} 个字符，${decision.metrics.lineCount.toLocaleString()} 行。`
}
