import type { DesktopSessionPart } from "@shared/session-types"

export type AssistantContentUnit =
  | { id: string; type: "markdown"; text: string; phase?: "commentary" | "final_answer" }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "tool"; call: DesktopSessionPart; result?: DesktopSessionPart }
  | { id: string; type: "error"; text: string }

export type FileReference = { path: string; line?: number }

export type ChangedFile = {
  path: string
  additions: number
  deletions: number
  hasStats: boolean
}

const mutationToolPattern =
  /(?:apply[_-]?patch|write|edit|create|delete|remove|move|rename|replace)/i
const pathKeys = new Set(["path", "file", "filePath", "file_path", "target", "destination"])

export function buildAssistantContent(parts: DesktopSessionPart[]): AssistantContentUnit[] {
  const units: AssistantContentUnit[] = []
  const results = new Map(
    parts
      .filter((part) => part.type === "tool_result" && part.toolUseId)
      .map((part) => [part.toolUseId as string, part])
  )

  for (const part of parts) {
    if (part.type === "tool_result") continue
    if (part.type === "text" && part.text) {
      const previous = units.at(-1)
      if (previous?.type === "markdown") previous.text += part.text
      else if (part.text.trim()) {
        const phase = assistantPhase(part.metadata.phase)
        units.push({ id: part.id, type: "markdown", text: part.text, ...(phase ? { phase } : {}) })
      }
      continue
    }
    if (part.type === "reasoning" && part.text) {
      units.push({ id: part.id, type: "reasoning", text: part.text })
      continue
    }
    if (part.type === "tool") {
      units.push({
        id: part.id,
        type: "tool",
        call: part,
        result: part.toolUseId ? results.get(part.toolUseId) : undefined,
      })
      continue
    }
    if (part.type === "error" || part.isError) {
      units.push({ id: part.id, type: "error", text: part.text || formatValue(part.output) })
    }
  }
  return units
}

function assistantPhase(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined
}

export function parseFileReference(value: string): FileReference | null {
  const text = value.trim().replace(/^file:\/\//i, "")
  if (!text || /^(?:https?:|mailto:|#)/i.test(text) || text.startsWith("-")) return null
  const match = text.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/)
  const path = match?.[1]?.replace(/^[`'"]|[`'"]$/g, "") ?? text
  const hasSeparator = /[\\/]/.test(path)
  const hasExtension = /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}$/i.test(path)
  if (!hasSeparator && !hasExtension) return null
  if (/\s/.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null
  return { path, line: match?.[2] ? Number(match[2]) : undefined }
}

export function parseInlineFileReference(value: string): FileReference | null {
  const reference = parseFileReference(value)
  if (!reference) return null
  if (!/[\\/]/.test(reference.path)) return null

  const name = reference.path.split(/[\\/]/).filter(Boolean).pop() ?? ""
  if (!isFileLikeName(name)) return null
  if (isLikelyDependencyOrGeneratedPath(reference.path)) return null
  return reference
}

export function collectChangedFiles(parts: DesktopSessionPart[]): ChangedFile[] {
  const changes = new Map<string, ChangedFile>()
  for (const part of parts) {
    if (part.type !== "tool" || !mutationToolPattern.test(part.toolName ?? "")) continue
    const patch = findPatch(part.input)
    if (patch) collectPatchChanges(patch, changes)
    for (const path of collectPaths(part.input)) addChange(changes, path, 0, 0, false)
  }
  return [...changes.values()]
}

export function isTurnComplete(parts: DesktopSessionPart[]): boolean {
  return parts.every((part) => part.status !== "pending" && part.status !== "running")
}

export function summarizeToolCall(part: DesktopSessionPart): { name: string; detail?: string } {
  const rawName = part.toolName || "tool"
  const normalized = rawName.toLocaleLowerCase().replace(/[-_]/g, "")
  const names: Array<[RegExp, string]> = [
    [/^(?:glob|listfiles|findfiles)/, "查找文件"],
    [/^(?:read|readfile)/, "读取文件"],
    [/^(?:write|writefile|createfile)/, "写入文件"],
    [/^(?:edit|editfile|replace)/, "编辑文件"],
    [/applypatch/, "应用补丁"],
    [/^(?:bash|shell|terminal|exec|command)/, "运行命令"],
    [/search/, "搜索内容"],
    [/browser|navigate|openurl/, "浏览网页"],
    [/fetch|http|request/, "请求网络"],
  ]
  const name = names.find(([pattern]) => pattern.test(normalized))?.[1] ?? humanizeToolName(rawName)
  return { name, detail: summarizeToolInput(part.input) }
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function collectPaths(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  const paths: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (pathKeys.has(key) && typeof child === "string" && parseFileReference(child))
      paths.push(child)
    else if (child && typeof child === "object") paths.push(...collectPaths(child))
  }
  return paths
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "pattern",
    "query",
    "command",
    "cmd",
    "url",
    "cwd",
  ]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return truncateSummary(value.trim())
  }
  const primitive = Object.values(input).find(
    (value): value is string | number | boolean =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  )
  return primitive === undefined ? undefined : truncateSummary(String(primitive))
}

function humanizeToolName(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
  return words ? words[0].toLocaleUpperCase() + words.slice(1) : "运行工具"
}

function truncateSummary(value: string): string {
  const oneLine = value.replace(/\s+/g, " ")
  return oneLine.length > 88 ? `${oneLine.slice(0, 85)}...` : oneLine
}

function isFileLikeName(name: string): boolean {
  if (/^[^.\\/]+\.[a-z0-9]{1,12}$/i.test(name)) return true
  return /^(?:dockerfile|makefile|license|readme|changelog)$/i.test(name)
}

function isLikelyDependencyOrGeneratedPath(path: string): boolean {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .map((segment) => segment.toLocaleLowerCase())
  const excludedSegments = new Set([
    ".build",
    ".cache",
    ".git",
    ".gradle",
    ".m2",
    ".mypy_cache",
    ".next",
    ".nuxt",
    ".parcel-cache",
    ".pnpm",
    ".pytest_cache",
    ".ruff_cache",
    ".svelte-kit",
    ".turbo",
    ".venv",
    ".vite",
    ".yarn",
    "__pycache__",
    "build",
    "cmakefiles",
    "coverage",
    "deriveddata",
    "dist",
    "env",
    "node_modules",
    "obj",
    "out",
    "site-packages",
    "target",
    "vendor",
    "venv",
  ])

  if (segments.some((segment) => excludedSegments.has(segment))) return true
  return hasSegmentPair(segments, "pkg", "mod") || hasSegmentPair(segments, ".cargo", "registry")
}

function hasSegmentPair(segments: string[], first: string, second: string): boolean {
  return segments.some((segment, index) => segment === first && segments[index + 1] === second)
}

function findPatch(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /patch|diff/i.test(key)) return child
    if (child && typeof child === "object") {
      const nested = findPatch(child)
      if (nested) return nested
    }
  }
  return null
}

function collectPatchChanges(patch: string, changes: Map<string, ChangedFile>): void {
  let currentPath: string | null = null
  let additions = 0
  let deletions = 0
  const flush = (): void => {
    if (currentPath) addChange(changes, currentPath, additions, deletions, true)
    additions = 0
    deletions = 0
  }
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    const gitHeader = line.match(/^\+\+\+ [ab]\/(.+)$/)
    if (header || gitHeader) {
      flush()
      currentPath = (header?.[1] ?? gitHeader?.[1] ?? "").trim()
    } else if (currentPath && line.startsWith("+") && !line.startsWith("+++")) additions += 1
    else if (currentPath && line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  flush()
}

function addChange(
  changes: Map<string, ChangedFile>,
  rawPath: string,
  additions: number,
  deletions: number,
  hasStats: boolean
): void {
  const reference = parseFileReference(rawPath)
  if (!reference) return
  const existing = changes.get(reference.path)
  changes.set(reference.path, {
    path: reference.path,
    additions: (existing?.additions ?? 0) + additions,
    deletions: (existing?.deletions ?? 0) + deletions,
    hasStats: Boolean(existing?.hasStats || hasStats),
  })
}
