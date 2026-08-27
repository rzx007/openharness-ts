import { readdir, readFile, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { clipboard, shell } from "electron"

import type {
  WorkspaceCopyPathInput,
  WorkspaceFileEntry,
  WorkspaceListFilesInput,
  WorkspaceListFilesResult,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceRevealPathInput,
} from "../../../shared/workspace-types"

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
])
const maxFileBytes = 1_250_000
const textDecoder = new TextDecoder("utf-8", { fatal: false })

class WorkspaceService {
  async listFiles(input: WorkspaceListFilesInput): Promise<WorkspaceListFilesResult> {
    const rootPath = await resolveDirectory(input.rootPath)
    const entries: WorkspaceFileEntry[] = []

    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true })
      children.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
        return left.name.localeCompare(right.name)
      })

      for (const child of children) {
        if (child.name.startsWith(".") && ignoredDirectories.has(child.name)) continue
        if (child.isDirectory() && ignoredDirectories.has(child.name)) continue
        if (child.isSymbolicLink()) continue

        const absolutePath = resolve(directory, child.name)
        const relativePath = toRelativeProjectPath(rootPath, absolutePath)

        if (child.isDirectory()) {
          entries.push({ path: `${relativePath}/`, type: "directory" })
          await visit(absolutePath)
          continue
        }

        if (child.isFile()) {
          let size: number | undefined
          try {
            size = (await stat(absolutePath)).size
          } catch {
            size = undefined
          }
          entries.push({ path: relativePath, type: "file", size })
        }
      }
    }

    await visit(rootPath)
    return { rootPath, entries }
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    const rootPath = await resolveDirectory(input.rootPath)
    const absolutePath = resolveInsideRoot(rootPath, input.path)
    const info = await stat(absolutePath)
    if (!info.isFile()) throw new Error("只能预览文件。")
    if (info.size > maxFileBytes) {
      return toReadResult(input.path, info.size, true, null)
    }

    const buffer = await readFile(absolutePath)
    const binary = isLikelyBinary(buffer)
    return toReadResult(input.path, info.size, binary, binary ? null : textDecoder.decode(buffer))
  }

  async revealPath(input: WorkspaceRevealPathInput): Promise<void> {
    const rootPath = await resolveDirectory(input.rootPath)
    const absolutePath = resolveInsideRoot(rootPath, input.path)
    const info = await stat(absolutePath)

    if (info.isDirectory()) {
      const error = await shell.openPath(absolutePath)
      if (error) throw new Error(error)
      return
    }

    shell.showItemInFolder(absolutePath)
  }

  async copyPath(input: WorkspaceCopyPathInput): Promise<string> {
    const rootPath = await resolveDirectory(input.rootPath)
    const absolutePath = resolveInsideRoot(rootPath, input.path)
    const text = input.absolute ? absolutePath : toRelativeProjectPath(rootPath, absolutePath)
    clipboard.writeText(text)
    return text
  }
}

async function resolveDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new Error("项目路径不能为空。")
  const path = resolve(value)
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error("项目路径不是目录。")
  return path
}

function resolveInsideRoot(rootPath: string, relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("文件路径不能为空。")
  const normalizedInput = relativePath.replace(/\\/g, "/").replace(/^\/+/, "")
  const absolutePath = resolve(rootPath, normalizedInput)
  const relativePathFromRoot = relative(rootPath, absolutePath)
  if (
    relativePathFromRoot === "" ||
    relativePathFromRoot.startsWith("..") ||
    isAbsolute(relativePathFromRoot)
  ) {
    throw new Error("文件必须位于当前项目目录内。")
  }
  return absolutePath
}

function toRelativeProjectPath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/")
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000))
  return sample.includes(0)
}

function toReadResult(
  path: string,
  size: number,
  binary: boolean,
  content: string | null
): WorkspaceReadFileResult {
  return {
    path,
    name: basename(path),
    language: languageFromPath(path),
    size,
    binary,
    content,
  }
}

function languageFromPath(path: string): string {
  const extension = extname(path).toLowerCase()
  switch (extension) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return "javascript"
    case ".cts":
    case ".mts":
    case ".ts":
      return "typescript"
    case ".tsx":
      return "tsx"
    case ".jsx":
      return "jsx"
    case ".css":
      return "css"
    case ".html":
      return "html"
    case ".json":
      return "json"
    case ".md":
    case ".mdx":
      return "markdown"
    case ".py":
      return "python"
    case ".rs":
      return "rust"
    case ".go":
      return "go"
    case ".java":
      return "java"
    case ".yml":
    case ".yaml":
      return "yaml"
    default:
      return extension.slice(1) || "text"
  }
}

export const workspaceService = new WorkspaceService()
