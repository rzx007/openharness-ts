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
  it("lists only existing Windows shells and never returns git-bash.exe", () => {
    const exists = new Set([
      "C:\\Pwsh\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Program Files\\Git\\git-bash.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
    ])
    const shells = listDetectedTerminalShells({
      platform: "win32",
      env: windowsEnv,
      fileExists: (path) => exists.has(path),
      joinPath: (...parts) => parts.join("\\"),
    })
    expect(shells.map((item) => item.id)).toEqual(["pwsh", "powershell", "cmd", "git-bash"])
    expect(shells.find((item) => item.id === "git-bash")?.command).toBe(
      "C:\\Program Files\\Git\\bin\\bash.exe"
    )
    expect(toPublicTerminalShells(shells).every((item) => !("command" in item))).toBe(true)
  })

  it("omits Git Bash when only the windowed launcher exists", () => {
    const exists = new Set([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Program Files\\Git\\git-bash.exe",
    ])
    const shells = listDetectedTerminalShells({
      platform: "win32",
      env: windowsEnv,
      fileExists: (path) => exists.has(path),
      joinPath: (...parts) => parts.join("\\"),
    })
    expect(shells.map((item) => item.id)).toEqual(["cmd"])
  })

  it("lists macOS and Linux binaries that exist", () => {
    expect(
      listDetectedTerminalShells({
        platform: "darwin",
        env: {},
        fileExists: (path) => path === "/bin/zsh",
        joinPath: (...parts) => parts.join("/"),
      }).map((item) => item.id)
    ).toEqual(["zsh"])
    expect(
      listDetectedTerminalShells({
        platform: "linux",
        env: {},
        fileExists: (path) => path === "/bin/bash" || path === "/bin/sh",
        joinPath: (...parts) => parts.join("/"),
      }).map((item) => item.id)
    ).toEqual(["bash", "sh"])
  })

  it("resolves a known id to its command and falls back when missing", () => {
    const shells = [{ id: "pwsh", label: "PowerShell 7", command: "C:\\Pwsh\\pwsh.exe" }]
    expect(resolvePreferredTerminalShell("pwsh", shells)).toBe("C:\\Pwsh\\pwsh.exe")
    expect(resolvePreferredTerminalShell("git-bash", shells)).toBeUndefined()
    expect(resolvePreferredTerminalShell(null, shells)).toBeUndefined()
    expect(resolvePreferredTerminalShell("system", shells)).toBeUndefined()
  })
})
