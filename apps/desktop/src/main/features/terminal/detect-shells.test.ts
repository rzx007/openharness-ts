import { posix, win32 } from "node:path"

import { describe, expect, it } from "vitest"

import {
  listDetectedTerminalShells,
  resolvePreferredTerminalShell,
  toPublicTerminalShells,
} from "./detect-shells"

const windowsEnv = {
  Path: "C:\\Pwsh;C:\\Windows\\System32",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
}

describe("detect-shells", () => {
  describe("win32", () => {
    it("lists only existing Windows shells and never returns git-bash.exe", () => {
      const exists = new Set([
        win32.join("C:\\Pwsh", "pwsh.exe"),
        win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        win32.join("C:\\Windows", "System32", "cmd.exe"),
        win32.join("C:\\Program Files", "Git", "git-bash.exe"),
        win32.join("C:\\Program Files", "Git", "bin", "bash.exe"),
      ])
      const shells = detect("win32", exists)
      expect(shells.map((item) => item.id)).toEqual(["pwsh", "powershell", "cmd", "git-bash"])
      expect(shells.find((item) => item.id === "git-bash")?.command).toBe(
        win32.join("C:\\Program Files", "Git", "bin", "bash.exe")
      )
      expect(toPublicTerminalShells(shells).every((item) => !("command" in item))).toBe(true)
    })

    it("finds Git Bash on D when C is empty, and prefers C when both exist", () => {
      const dBash = win32.join("D:\\Program Files", "Git", "bin", "bash.exe")
      const cBash = win32.join("C:\\Program Files", "Git", "bin", "bash.exe")
      const cmd = win32.join("C:\\Windows", "System32", "cmd.exe")

      expect(detect("win32", new Set([cmd, dBash])).find((item) => item.id === "git-bash")?.command).toBe(
        dBash
      )
      expect(
        detect("win32", new Set([cmd, cBash, dBash])).find((item) => item.id === "git-bash")?.command
      ).toBe(cBash)
    })

    it("omits Git Bash when only the windowed launcher exists", () => {
      const exists = new Set([
        win32.join("C:\\Windows", "System32", "cmd.exe"),
        win32.join("C:\\Program Files", "Git", "git-bash.exe"),
      ])
      expect(detect("win32", exists).map((item) => item.id)).toEqual(["cmd"])
    })
  })

  describe("darwin", () => {
    it("lists /bin shells and ignores Windows Git Bash paths", () => {
      const exists = new Set(["/bin/zsh", "/bin/bash", win32.join("D:\\Program Files", "Git", "bin", "bash.exe")])
      expect(detect("darwin", exists).map((item) => item.id)).toEqual(["zsh", "bash"])
    })
  })

  describe("linux", () => {
    it("lists /bin shells and ignores Windows Git Bash paths", () => {
      const exists = new Set(["/bin/bash", "/bin/sh", win32.join("C:\\Program Files", "Git", "bin", "bash.exe")])
      expect(detect("linux", exists).map((item) => item.id)).toEqual(["bash", "sh"])
    })
  })

  it("resolves a known id to its command and falls back when missing", () => {
    const shells = [{ id: "pwsh", label: "PowerShell 7", command: win32.join("C:\\Pwsh", "pwsh.exe") }]
    expect(resolvePreferredTerminalShell("pwsh", shells)).toBe(win32.join("C:\\Pwsh", "pwsh.exe"))
    expect(resolvePreferredTerminalShell("git-bash", shells)).toBeUndefined()
    expect(resolvePreferredTerminalShell(null, shells)).toBeUndefined()
    expect(resolvePreferredTerminalShell("system", shells)).toBeUndefined()
  })
})

function detect(platform: "win32" | "darwin" | "linux", exists: Set<string>) {
  return listDetectedTerminalShells({
    platform,
    env: platform === "win32" ? windowsEnv : {},
    fileExists: (path) => exists.has(path),
    joinPath: platform === "win32" ? win32.join : posix.join,
  })
}
