import { DEFAULT_THEMES, type FileDiffOptions } from "@pierre/diffs"
import { PatchDiff } from "@pierre/diffs/react"
import {
  AlertCircle,
  ChevronDown,
  FileCode2,
  FileDiff,
  PanelRightOpen,
  Pencil,
  TerminalSquare,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Streamdown } from "streamdown"

import { Button } from "@renderer/components/ui/button"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import type { DesktopSessionPart } from "@shared/session-types"

import {
  buildAssistantContent,
  collectChangedFiles,
  formatValue,
  isTurnComplete,
  summarizeToolCall,
  type AssistantContentUnit,
  type ChangedFile,
} from "./message-render-model"
import { createStreamdownComponents } from "./streamdown-components"
import { streamdownPlugins } from "./streamdown-plugins"

type InlineDiffState = "idle" | "loading" | "ready" | "error"

const inlineDiffOptions: FileDiffOptions<undefined> = {
  collapsedContextThreshold: 6,
  disableFileHeader: true,
  diffStyle: "unified",
  hunkSeparators: "line-info-basic",
  lineDiffType: "word",
  overflow: "scroll",
  theme: DEFAULT_THEMES,
  tokenizeMaxLength: 160_000,
  tokenizeMaxLineLength: 16_000,
  unsafeCSS: `
    :host {
      display: block;
      min-width: max-content;
      background: transparent;
      color: var(--content-foreground);
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 18px;
    }

    pre {
      margin: 0;
      min-width: max-content;
      background: transparent !important;
      font-family: var(--font-mono) !important;
      font-size: 11px !important;
      line-height: 18px !important;
    }
  `,
}

export function AssistantMessage({
  parts,
  streaming,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  parts: DesktopSessionPart[]
  streaming: boolean
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const units = useMemo(() => buildAssistantContent(parts), [parts])
  const blocks = useMemo(() => groupToolUnits(units), [units])
  const changedFiles = useMemo(() => collectChangedFiles(parts), [parts])
  if (parts.length === 0) return <span className="text-xs text-ui-muted">正在生成回复...</span>

  return (
    <div className="group/assistant min-w-0 space-y-4">
      {blocks.map((block, index) => {
        if (block.type === "tool-group") {
          return <ToolActivityGroup key={block.id} tools={block.tools} />
        }
        if (block.type === "terminal") {
          return (
            <TerminalActivityCard
              key={block.id}
              payload={block.payload}
              active={isTerminalActivityActive(block, streaming && index === blocks.length - 1)}
              onOpenTerminal={onOpenTerminal}
            />
          )
        }
        const unit = block.unit
        if (unit.type === "markdown") {
          return (
            <AssistantMarkdown
              key={unit.id}
              text={unit.text}
              streaming={streaming && index === blocks.length - 1}
              onOpenFile={onOpenFile}
            />
          )
        }
        if (unit.type === "reasoning") {
          return (
            <details key={unit.id} className="text-[13px] text-ui-muted">
              <summary className="w-fit cursor-pointer font-medium select-none hover:text-foreground">
                思考过程
              </summary>
              <p className="mt-2 border-l pl-3.5 leading-6 whitespace-pre-wrap">{unit.text}</p>
            </details>
          )
        }
        return (
          <div
            key={unit.id}
            className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive"
          >
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="whitespace-pre-wrap">{unit.text}</span>
          </div>
        )
      })}

      {!streaming && isTurnComplete(parts) && changedFiles.length > 0 ? (
        <ChangedFilesSummary
          files={changedFiles}
          canOpenReview={canOpenReview}
          onOpenFile={onOpenFile}
          onOpenReview={onOpenReview}
        />
      ) : null}
    </div>
  )
}

function AssistantMarkdown({
  text,
  streaming,
  onOpenFile,
}: {
  text: string
  streaming: boolean
  onOpenFile: (path: string, line?: number) => void
}): React.JSX.Element {
  const components = useMemo(() => createStreamdownComponents({ onOpenFile }), [onOpenFile])

  return (
    <div className="assistant-markdown min-w-0">
      <Streamdown
        className="desktop-streamdown space-y-0"
        animated
        mode={streaming ? "streaming" : "static"}
        controls
        lineNumbers={false}
        parseIncompleteMarkdown={streaming}
        plugins={streamdownPlugins}
        components={components}
      >
        {text}
      </Streamdown>
    </div>
  )
}

type ToolUnit = Extract<AssistantContentUnit, { type: "tool" }>
type ContentBlock =
  | { id: string; type: "unit"; unit: Exclude<AssistantContentUnit, ToolUnit> }
  | { id: string; type: "tool-group"; tools: ToolUnit[] }
  | { id: string; type: "terminal"; payload: TerminalToolPayload; tool: ToolUnit }

function isToolInFlight(tool: ToolUnit): boolean {
  const status = tool.call.status
  if (status === "pending" || status === "running") return true
  return !tool.result && status !== "completed" && status !== "failed" && status !== "interrupted"
}

function isTerminalActivityActive(
  block: Extract<ContentBlock, { type: "terminal" }>,
  isLiveTail: boolean
): boolean {
  if (isToolInFlight(block.tool)) return true
  return isLiveTail && block.payload.terminal?.status === "running"
}

function groupToolUnits(units: AssistantContentUnit[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const unit of units) {
    if (unit.type !== "tool") {
      blocks.push({ id: unit.id, type: "unit", unit })
      continue
    }
    const terminal = parseTerminalToolPayload(unit.call.output ?? unit.result?.output)
    if (terminal?.action === "open" && terminal.terminal) {
      blocks.push({ id: `terminal-${unit.id}`, type: "terminal", payload: terminal, tool: unit })
      continue
    }
    const previous = blocks.at(-1)
    if (previous?.type === "tool-group") previous.tools.push(unit)
    else blocks.push({ id: `tools-${unit.id}`, type: "tool-group", tools: [unit] })
  }
  return blocks
}

type TerminalToolPayload = {
  kind: "terminal"
  action: string
  terminal?: {
    id: string
    name: string
    cwd: string
    shell: string
    status: "running" | "stopping" | "completed" | "killed" | "failed"
  }
}

function TerminalActivityCard({
  payload,
  active,
  onOpenTerminal,
}: {
  payload: TerminalToolPayload
  active: boolean
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element | null {
  const terminal = payload.terminal
  if (!terminal) return null
  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-muted/18 text-[13px] shadow-sm">
      <div className="flex min-h-16 items-center gap-3 px-3.5 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-ui-muted">
          <TerminalSquare className="size-[18px]" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                terminal.status === "running" ? "bg-emerald-500" : "bg-ui-muted/60"
              )}
            />
            <h3 className={cn("truncate font-semibold text-foreground", active && "shimmer")}>
              {terminal.name}
            </h3>
          </div>
          <p className="mt-0.5 truncate text-xs text-ui-muted" title={terminal.cwd}>
            {terminal.cwd}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => onOpenTerminal(terminal.id)}>
          <PanelRightOpen data-icon="inline-start" />
          打开终端
        </Button>
      </div>
    </section>
  )
}

function parseTerminalToolPayload(value: unknown): TerminalToolPayload | null {
  const text = terminalPayloadText(value)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<TerminalToolPayload>
    return parsed.kind === "terminal" && typeof parsed.action === "string"
      ? (parsed as TerminalToolPayload)
      : null
  } catch {
    return null
  }
}

function terminalPayloadText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return null
  const content = "content" in value ? value.content : undefined
  if (!Array.isArray(content)) return null
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      !!item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
  )
  return block?.text ?? null
}

function ToolActivityGroup({ tools }: { tools: ToolUnit[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = tools.some(isToolInFlight)
  const edits = tools.filter((tool) =>
    /write|edit|patch|create|delete/i.test(tool.call.toolName ?? "")
  )
  const commands = tools.filter((tool) =>
    /bash|shell|terminal|exec|command/i.test(tool.call.toolName ?? "")
  )
  const reads = tools.length - edits.length - commands.length
  const heading = [
    edits.length ? `编辑了 ${edits.length} 个文件` : "",
    commands.length ? `运行了 ${commands.length} 个命令` : "",
    reads > 0 ? `执行了 ${reads} 次查看` : "",
  ]
    .filter(Boolean)
    .join("，")
  return (
    <section className="text-[13px] text-ui-muted">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-7 max-w-full items-center gap-2 hover:text-foreground",
          active && "shimmer"
        )}
      >
        <Pencil className="size-3.5 shrink-0" strokeWidth={1.7} />
        <span className="truncate">{heading || `执行了 ${tools.length} 个工具`}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="mt-1 space-y-0.5 border-l border-border/70 pl-4">
          {tools.map((tool) => {
            const summary = summarizeToolCall(tool.call)
            const active = activeId === tool.id
            const calling = isToolInFlight(tool)
            const output = tool.result?.output ?? tool.call.output ?? tool.call.input
            return (
              <div key={tool.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(active ? null : tool.id)}
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-2 text-left hover:text-foreground",
                    calling && "shimmer"
                  )}
                >
                  <TerminalSquare className="size-3.5 shrink-0" strokeWidth={1.6} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-ui-foreground">{summary.name}</span>
                    {summary.detail ? (
                      <span className="ml-1.5 text-ui-muted/80">{summary.detail}</span>
                    ) : null}
                  </span>
                  <ChevronDown
                    className={cn("size-3.5 shrink-0 transition-transform", active && "rotate-180")}
                  />
                </button>
                {active ? (
                  <div className="mb-2 overflow-hidden rounded-md border bg-muted/30">
                    <div className="border-b px-3 py-1.5 text-xs">
                      {tool.call.toolName || "Tool"}
                    </div>
                    <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap">
                      {formatValue(output)}
                    </pre>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function ChangedFilesSummary({
  files,
  canOpenReview,
  onOpenFile,
  onOpenReview,
}: {
  files: ChangedFile[]
  canOpenReview: boolean
  onOpenFile: (path: string, line?: number) => void
  onOpenReview: (path?: string) => void
}): React.JSX.Element {
  const selectedProjectPath = useDesktopSessionStore((state) => state.selectedProject?.path)
  const [expanded, setExpanded] = useState(false)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [diffState, setDiffState] = useState<InlineDiffState>("idle")
  const [patch, setPatch] = useState("")
  const [diffBinary, setDiffBinary] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const visible = expanded ? files : files.slice(0, 3)
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  const hasStats = files.some((file) => file.hasStats)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!canOpenReview || !selectedProjectPath || !activePath) {
        setPatch("")
        setDiffBinary(false)
        setDiffError(null)
        setDiffState("idle")
        return
      }

      const relativePath = toProjectRelativePath(activePath, selectedProjectPath)
      if (!relativePath) {
        setPatch("")
        setDiffBinary(false)
        setDiffError("该文件不在当前项目目录内。")
        setDiffState("error")
        return
      }

      setDiffState("loading")
      setDiffError(null)
      void window.desktop.git
        .fileDiff({
          rootPath: selectedProjectPath,
          path: relativePath,
          scope: "uncommitted",
        })
        .then((result) => {
          if (cancelled) return
          setPatch(result.patch)
          setDiffBinary(result.binary)
          setDiffState("ready")
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setPatch("")
          setDiffBinary(false)
          setDiffError(errorMessage(error))
          setDiffState("error")
        })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activePath, canOpenReview, selectedProjectPath])

  const handleFileClick = (file: ChangedFile): void => {
    if (!canOpenReview) {
      onOpenFile(file.path)
      return
    }
    const nextPath = activePath === file.path ? null : file.path
    setActivePath(nextPath)
    setDiffState(nextPath ? "loading" : "idle")
    if (!nextPath) {
      setPatch("")
      setDiffBinary(false)
      setDiffError(null)
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border bg-transparent text-[13px]">
      <header className="flex min-h-15 items-center gap-3 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted/75 text-ui-muted">
          <FileCode2 className="size-[18px]" strokeWidth={1.7} />
        </span>
        <div>
          <h3 className="text-[14px] font-semibold text-foreground">
            已编辑 {files.length} 个文件
          </h3>
          {hasStats ? (
            <p className="mt-0.5">
              <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>{" "}
              <span className="text-red-500">-{deletions}</span>
            </p>
          ) : null}
        </div>
      </header>
      <div className="border-t">
        {visible.map((file) => {
          const open = canOpenReview && activePath === file.path
          return (
            <div key={file.path} className="border-b last:border-b-0">
              <div className="flex min-h-11 items-center gap-2 px-3 transition-colors hover:bg-muted/45">
                <button
                  type="button"
                  onClick={() => handleFileClick(file)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                >
                  {canOpenReview ? (
                    <ChevronDown
                      className={cn(
                        "size-3.5 shrink-0 text-ui-muted transition-transform",
                        open && "rotate-180"
                      )}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ui-muted">
                    {file.path}
                  </span>
                  {file.hasStats ? (
                    <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{file.additions}
                      </span>
                      <span className="ml-1 text-red-500">-{file.deletions}</span>
                    </span>
                  ) : null}
                </button>
                {canOpenReview ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-ui-muted hover:text-foreground"
                    title="打开审阅"
                    aria-label={`打开审阅：${file.path}`}
                    onClick={() => onOpenReview(file.path)}
                  >
                    <PanelRightOpen className="size-4" />
                  </Button>
                ) : null}
              </div>
              {open ? (
                <InlineFileDiffPreview
                  state={diffState}
                  patch={patch}
                  binary={diffBinary}
                  error={diffError}
                />
              ) : null}
            </div>
          )
        })}
      </div>
      {!expanded && files.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-9 items-center gap-2 px-3 font-medium text-ui-muted hover:text-foreground"
        >
          再显示 {files.length - 3} 个文件 <ChevronDown className="size-3.5" />
        </button>
      ) : null}
    </section>
  )
}

function InlineFileDiffPreview({
  state,
  patch,
  binary,
  error,
}: {
  state: InlineDiffState
  patch: string
  binary: boolean
  error: string | null
}): React.JSX.Element {
  if (state === "loading") {
    return (
      <div className="flex min-h-28 items-center justify-center gap-2 border-t bg-muted/15 text-[13px] text-ui-muted">
        <Spinner className="size-3.5" />
        正在读取 diff...
      </div>
    )
  }

  if (state === "error") {
    return <InlineDiffEmptyState title="无法读取文件 diff" description={error ?? "请稍后重试。"} />
  }

  if (binary) {
    return <InlineDiffEmptyState title="二进制文件" description="这类改动暂不展示文本 diff。" />
  }

  if (!patch.startsWith("diff --git")) {
    return <InlineDiffEmptyState title="没有可展示的文本 diff" description="该文件没有文本差异。" />
  }

  return (
    <div className="max-h-96 overflow-auto border-t bg-background">
      <PatchDiff
        key={patch.length}
        patch={patch}
        options={{ ...inlineDiffOptions, themeType: resolveThemeType() }}
        className="min-w-max"
      />
    </div>
  )
}

function InlineDiffEmptyState({
  title,
  description,
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-28 items-center justify-center border-t bg-muted/15 px-4 py-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <FileDiff className="size-4 text-muted-foreground" />
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        <p className="text-xs leading-5 text-ui-muted">{description}</p>
      </div>
    </div>
  )
}

function resolveThemeType(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
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
