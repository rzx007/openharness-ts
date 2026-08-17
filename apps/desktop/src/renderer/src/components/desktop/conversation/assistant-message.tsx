import {
  AlertCircle,
  ChevronDown,
  FileCode2,
  PanelRightOpen,
  Pencil,
  TerminalSquare,
} from "lucide-react"
import { useMemo, useState } from "react"
import { Streamdown } from "streamdown"

import { cn } from "@renderer/lib/utils"
import { Button } from "@renderer/components/ui/button"
import type { DesktopSessionPart } from "@shared/session-types"

import {
  buildAssistantContent,
  collectChangedFiles,
  formatValue,
  isTurnComplete,
  parseFileReference,
  summarizeToolCall,
  type AssistantContentUnit,
  type ChangedFile,
} from "./message-render-model"
import { streamdownPlugins } from "./streamdown-plugins"

export function AssistantMessage({
  parts,
  streaming,
  onOpenFile,
  onOpenTerminal,
}: {
  parts: DesktopSessionPart[]
  streaming: boolean
  onOpenFile: (path: string, line?: number) => void
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
          return <ToolActivityGroup key={block.id} tools={block.tools} initiallyOpen={streaming} />
        }
        if (block.type === "terminal") {
          return (
            <TerminalActivityCard
              key={block.id}
              payload={block.payload}
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
        <ChangedFilesSummary files={changedFiles} onOpenFile={onOpenFile} />
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
  return (
    <div className="assistant-markdown min-w-0">
      <Streamdown
        className="desktop-streamdown space-y-0"
        mode={streaming ? "streaming" : "static"}
        controls
        lineNumbers={false}
        parseIncompleteMarkdown={streaming}
        plugins={streamdownPlugins}
        components={{
          a: ({ href, children, ...props }) => {
            const file = href ? parseFileReference(href) : null
            if (!file)
              return (
                <a href={href} data-streamdown="link" {...props}>
                  {children}
                </a>
              )
            return (
              <FileButton path={file.path} line={file.line} onOpenFile={onOpenFile}>
                {children}
              </FileButton>
            )
          },
          inlineCode: ({ children, ...props }) => {
            const value = String(children).replace(/\n$/, "")
            const file = parseFileReference(value)
            if (!file)
              return (
                <code data-streamdown="inline-code" {...props}>
                  {children}
                </code>
              )
            return (
              <FileButton path={file.path} line={file.line} onOpenFile={onOpenFile}>
                {children}
              </FileButton>
            )
          },
        }}
      >
        {text}
      </Streamdown>
    </div>
  )
}

function FileButton({
  path,
  line,
  onOpenFile,
  children,
}: {
  path: string
  line?: number
  onOpenFile: (path: string, line?: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  const sourceFile = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|cs|vue|svelte)(?::\d+)?$/i.test(path)
  return (
    <button
      type="button"
      title={`打开 ${path}`}
      onClick={() => onOpenFile(path, line)}
      className={cn(
        "assistant-file-link inline-flex max-w-full items-baseline gap-1 rounded-sm px-1 py-px align-baseline font-mono text-[0.9em] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        sourceFile && "assistant-file-link-source"
      )}
    >
      <FileReferenceIcon path={path} />
      <span className="truncate">{children}</span>
    </button>
  )
}

type ToolUnit = Extract<AssistantContentUnit, { type: "tool" }>
type ContentBlock =
  | { id: string; type: "unit"; unit: Exclude<AssistantContentUnit, ToolUnit> }
  | { id: string; type: "tool-group"; tools: ToolUnit[] }
  | { id: string; type: "terminal"; payload: TerminalToolPayload }

function groupToolUnits(units: AssistantContentUnit[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const unit of units) {
    if (unit.type !== "tool") {
      blocks.push({ id: unit.id, type: "unit", unit })
      continue
    }
    const terminal = parseTerminalToolPayload(unit.call.output ?? unit.result?.output)
    if (terminal?.action === "open" && terminal.terminal) {
      blocks.push({ id: `terminal-${unit.id}`, type: "terminal", payload: terminal })
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
  onOpenTerminal,
}: {
  payload: TerminalToolPayload
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
            <h3 className="truncate font-semibold text-foreground">{terminal.name}</h3>
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

function ToolActivityGroup({
  tools,
  initiallyOpen,
}: {
  tools: ToolUnit[]
  initiallyOpen: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen)
  const [activeId, setActiveId] = useState<string | null>(null)
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
        className="flex h-7 max-w-full items-center gap-2 hover:text-foreground"
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
            const output = tool.result?.output ?? tool.call.output ?? tool.call.input
            return (
              <div key={tool.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(active ? null : tool.id)}
                  className="flex h-7 w-full min-w-0 items-center gap-2 text-left hover:text-foreground"
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
  onOpenFile,
}: {
  files: ChangedFile[]
  onOpenFile: (path: string, line?: number) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? files : files.slice(0, 3)
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  const hasStats = files.some((file) => file.hasStats)
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
        {visible.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => onOpenFile(file.path)}
            className="flex h-11 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
          >
            <span className="min-w-0 flex-1 truncate text-[14px] text-ui-muted">{file.path}</span>
            {file.hasStats ? (
              <span className="shrink-0">
                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{" "}
                <span className="text-red-500">-{file.deletions}</span>
              </span>
            ) : null}
          </button>
        ))}
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

function FileReferenceIcon({ path }: { path: string }): React.JSX.Element {
  const extension = path.split(".").pop()?.toLocaleLowerCase()
  const labels: Record<string, string> = {
    ts: "TS",
    tsx: "TS",
    js: "JS",
    jsx: "JS",
    py: "PY",
    md: "MD",
  }
  const label = extension ? labels[extension] : undefined
  if (!label) return <FileCode2 className="size-3.5 shrink-0 self-center" strokeWidth={1.8} />
  return (
    <span aria-hidden="true" className="assistant-file-type self-center">
      {label}
    </span>
  )
}
