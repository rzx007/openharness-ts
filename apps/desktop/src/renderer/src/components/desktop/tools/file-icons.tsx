import {
  BookOpenText,
  File,
  FileArchive,
  FileBraces,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Settings,
  type LucideIcon,
} from "lucide-react"

export type FileIconKind =
  | "archive"
  | "code"
  | "config"
  | "data"
  | "document"
  | "image"
  | "markdown"
  | "spreadsheet"
  | "text"
  | "unknown"

const codeExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "cjs",
  "cts",
  "go",
  "java",
  "js",
  "jsx",
  "kt",
  "lua",
  "mjs",
  "mts",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
])

const configExtensions = new Set(["env", "ini", "toml", "xml", "yaml", "yml"])
const dataExtensions = new Set(["json", "jsonc", "jsonl", "lock", "sql"])
const documentExtensions = new Set(["doc", "docx", "pdf", "ppt", "pptx"])
const imageExtensions = new Set(["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"])
const spreadsheetExtensions = new Set(["csv", "tsv", "xls", "xlsx"])
const archiveExtensions = new Set(["7z", "br", "gz", "rar", "tar", "tgz", "zip"])

const configFileNames = new Set([
  ".editorconfig",
  ".env",
  ".env.example",
  ".gitignore",
  ".npmrc",
  "dockerfile",
  "makefile",
])

export function getFileIcon(pathOrName: string): LucideIcon {
  switch (getFileIconKind(pathOrName)) {
    case "archive":
      return FileArchive
    case "code":
      return FileCode2
    case "config":
      return Settings
    case "data":
      return FileBraces
    case "document":
      return FileText
    case "image":
      return FileImage
    case "markdown":
      return BookOpenText
    case "spreadsheet":
      return FileSpreadsheet
    case "text":
      return FileText
    default:
      return File
  }
}

export function getFileIconKind(pathOrName: string): FileIconKind {
  const name = fileNameFromPath(pathOrName).toLowerCase()
  const extension = fileExtension(name)

  if (name.endsWith(".md") || name.endsWith(".mdx")) return "markdown"
  if (configFileNames.has(name) || configExtensions.has(extension)) return "config"
  if (dataExtensions.has(extension)) return "data"
  if (codeExtensions.has(extension)) return "code"
  if (documentExtensions.has(extension)) return "document"
  if (imageExtensions.has(extension)) return "image"
  if (spreadsheetExtensions.has(extension)) return "spreadsheet"
  if (archiveExtensions.has(extension)) return "archive"
  if (extension === "txt" || extension === "log") return "text"
  return "unknown"
}

export function isMarkdownPath(pathOrName: string): boolean {
  const name = fileNameFromPath(pathOrName).toLowerCase()
  return name.endsWith(".md") || name.endsWith(".mdx")
}

function fileNameFromPath(pathOrName: string): string {
  return pathOrName.split(/[\\/]/).filter(Boolean).pop() ?? pathOrName
}

function fileExtension(name: string): string {
  const parts = name.split(".")
  return parts.length > 1 ? (parts.pop() ?? "") : ""
}
