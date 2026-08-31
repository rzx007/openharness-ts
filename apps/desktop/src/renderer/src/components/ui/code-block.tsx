"use client"

import { DEFAULT_THEMES, type FileContents } from "@pierre/diffs"
import { File as PierreFile, type FileOptions } from "@pierre/diffs/react"
import { Check, Copy, FileCode2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { cn } from "@renderer/lib/utils"
import { Button } from "@renderer/components/ui/button"
import { useTheme } from "@renderer/components/theme-provider"
import { previewLimits } from "@renderer/components/desktop/tools/file-preview-policy"

// -- Styles --
// Injected once at runtime — ships as a single self-contained file with no
// modifications to globals.css required.

const CB_STYLES = `
.cbhl pierre-file::part(line){background-color:oklch(0.828 0.189 84.429/.12)}`

function injectStyles(): void {
  if (typeof document === "undefined") return
  if (document.getElementById("ss-code-block")) return
  const el = document.createElement("style")
  el.id = "ss-code-block"
  el.textContent = CB_STYLES
  document.head.appendChild(el)
}

// -- Types --

interface CodeBlockProps {
  code: string
  language?: string
  filename?: string
  showLineNumbers?: boolean
  scrollable?: boolean
  maxHeight?: number
  highlightLines?: number[]
  /** Tailwind class(es) applied to the code body — e.g. "bg-muted", "bg-slate-950" */
  bodyClassName?: string
  className?: string
  renderMode?: "highlighted" | "plain"
}

// -- Copy button --

function CopyBtn({ code }: { code: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    if (typeof window === "undefined" || !navigator?.clipboard) return
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={copy}>
      {copied ? <Check className="h-3.5 w-3.5 text-teal-400" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

// -- Internal code renderer --

interface RendererProps {
  code: string
  language: string
  showLineNumbers: boolean
  scrollable: boolean
  maxHeight: number
  highlightLines?: number[]
  bodyClassName?: string
  renderMode: "highlighted" | "plain"
}

function CodeRenderer({
  code,
  language,
  showLineNumbers,
  scrollable,
  maxHeight,
  highlightLines,
  bodyClassName,
  renderMode,
}: RendererProps): React.JSX.Element {
  const { resolvedTheme: themeType } = useTheme()
  const file = useMemo<FileContents>(
    () => ({
      name: renderMode === "plain" ? "snippet.txt" : codeBlockFilename(language),
      contents: code,
      lang: renderMode === "plain" ? "text" : normalizeLanguage(language),
      cacheKey: `${language}:${code.length}:${hashCode(code)}:${renderMode}`,
    }),
    [code, language, renderMode]
  )
  const options = useMemo<FileOptions<undefined>>(
    () => ({
      disableFileHeader: true,
      disableLineNumbers: !showLineNumbers,
      overflow: "scroll",
      preferredHighlighter: "shiki-js",
      theme: DEFAULT_THEMES,
      themeType,
      tokenizeMaxLength: previewLimits["code-block"].lines,
      tokenizeMaxLineLength: previewLimits["code-block"].lineLength,
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
          white-space: pre;
          word-break: normal;
        }
      `,
    }),
    [showLineNumbers, themeType]
  )

  useEffect(() => {
    injectStyles()
  }, [])

  return (
    <div
      className={cn(
        "overflow-x-auto",
        scrollable && "overflow-y-auto",
        bodyClassName ?? "bg-background"
      )}
      style={scrollable ? { maxHeight: `${maxHeight}px` } : undefined}
    >
      <div className={cn("px-4 py-3", highlightLines?.length && "cbhl")}>
        <PierreFile file={file} options={options} />
      </div>
    </div>
  )
}

function codeBlockFilename(language: string): string {
  const extension = languageToExtension(language)
  return extension ? `snippet.${extension}` : "snippet.txt"
}

function normalizeLanguage(language: string): FileContents["lang"] | undefined {
  const normalized = language.trim().toLocaleLowerCase()
  if (!normalized || normalized === "text" || normalized === "txt" || normalized === "plain") {
    return undefined
  }
  const aliases: Record<string, string> = {
    bash: "shellscript",
    cjs: "javascript",
    h: "c",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    ps1: "powershell",
    py: "python",
    rb: "ruby",
    sh: "shellscript",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml",
  }
  return (aliases[normalized] ?? normalized) as FileContents["lang"]
}

function languageToExtension(language: string): string {
  const normalized = language.trim().toLocaleLowerCase()
  const extensions: Record<string, string> = {
    bash: "sh",
    javascript: "js",
    powershell: "ps1",
    python: "py",
    shellscript: "sh",
    typescript: "ts",
    yaml: "yml",
  }
  return (extensions[normalized] ?? normalized.replace(/[^a-z0-9_-]/g, "")) || "txt"
}

function hashCode(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash.toString(36)
}

// -- CodeBlock --

export function CodeBlock({
  code,
  language = "tsx",
  filename,
  showLineNumbers = false,
  scrollable = false,
  maxHeight = 400,
  highlightLines,
  bodyClassName,
  className,
  renderMode = "highlighted",
}: CodeBlockProps): React.JSX.Element {
  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <div className="flex h-10 items-center justify-between gap-2 border-b bg-muted/50 px-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <FileCode2 className="h-4 w-4 shrink-0" />
          <span className="truncate font-mono text-xs lowercase">{filename ?? language}</span>
        </div>
        <CopyBtn code={code} />
      </div>
      <CodeRenderer
        code={code}
        language={language}
        showLineNumbers={showLineNumbers}
        scrollable={scrollable}
        maxHeight={maxHeight}
        highlightLines={highlightLines}
        bodyClassName={bodyClassName}
        renderMode={renderMode}
      />
    </div>
  )
}
