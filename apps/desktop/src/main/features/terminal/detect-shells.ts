import { existsSync } from "node:fs"
import { join } from "node:path"

import { normalizeDefaultTerminalShellId } from "../../../shared/settings-types"

export type DetectedTerminalShell = { id: string; label: string; command: string }

export type DetectShellOps = {
  platform: string
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
  fileExists: (path: string) => boolean
  joinPath: (...parts: string[]) => string
}

export function listDetectedTerminalShells(ops?: DetectShellOps): DetectedTerminalShell[] {
  const resolved = ops ?? {
    platform: process.platform,
    env: process.env,
    fileExists: existsSync,
    joinPath: join,
  }

  if (resolved.platform === "win32") return detectWindowsShells(resolved)
  if (resolved.platform === "darwin") return detectPosixShells(["zsh", "bash"], resolved)
  return detectPosixShells(["bash", "sh"], resolved)
}

export function toPublicTerminalShells(
  shells: DetectedTerminalShell[]
): Array<{ id: string; label: string }> {
  return shells.map(({ id, label }) => ({ id, label }))
}

export function resolvePreferredTerminalShell(
  id: string | null | undefined,
  shells: DetectedTerminalShell[]
): string | undefined {
  const normalized = normalizeDefaultTerminalShellId(id)
  if (!normalized) return undefined
  return shells.find((item) => item.id === normalized)?.command
}

function detectWindowsShells(ops: DetectShellOps): DetectedTerminalShell[] {
  const shells: DetectedTerminalShell[] = []
  const pwsh = findOnPath("pwsh.exe", ops)
  if (pwsh) shells.push({ id: "pwsh", label: "PowerShell 7", command: pwsh })

  const systemRoot = ops.env.SystemRoot ?? "C:\\Windows"
  const powershell =
    firstExisting(
      [
        ops.joinPath(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        findOnPath("powershell.exe", ops),
      ],
      ops.fileExists
    ) ?? undefined
  if (powershell) shells.push({ id: "powershell", label: "Windows PowerShell", command: powershell })

  const cmd =
    firstExisting([ops.env.ComSpec, ops.env.COMSPEC, findOnPath("cmd.exe", ops)], ops.fileExists) ??
    undefined
  if (cmd) shells.push({ id: "cmd", label: "命令提示符", command: cmd })

  const programFiles = ops.env.ProgramFiles ?? "C:\\Program Files"
  const programFilesX86 = ops.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
  const gitBash = firstExisting(
    [
      ops.joinPath(programFiles, "Git", "bin", "bash.exe"),
      ops.joinPath(programFilesX86, "Git", "bin", "bash.exe"),
      ops.joinPath(programFiles, "Git", "usr", "bin", "bash.exe"),
      ops.joinPath(programFilesX86, "Git", "usr", "bin", "bash.exe"),
    ],
    ops.fileExists
  )
  if (gitBash) shells.push({ id: "git-bash", label: "Git Bash", command: gitBash })

  return shells
}

function detectPosixShells(
  names: Array<"zsh" | "bash" | "sh">,
  ops: DetectShellOps
): DetectedTerminalShell[] {
  const shells: DetectedTerminalShell[] = []
  for (const name of names) {
    const path = `/bin/${name}`
    if (ops.fileExists(path)) shells.push({ id: name, label: name, command: path })
  }
  return shells
}

function findOnPath(executable: string, ops: DetectShellOps): string | undefined {
  const path = ops.env.Path ?? ops.env.PATH ?? ""
  const delimiter = ops.platform === "win32" ? ";" : ":"
  for (const rawDirectory of path.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "")
    if (!directory) continue
    const candidate = ops.joinPath(directory, executable)
    if (ops.fileExists(candidate)) return candidate
  }
  return undefined
}

function firstExisting(
  candidates: Array<string | undefined>,
  fileExists: (path: string) => boolean
): string | undefined {
  return candidates.find((candidate): candidate is string => Boolean(candidate && fileExists(candidate)))
}
