import { describe, expect, it } from "vitest"

import { resolveSpawnInvocation } from "./resolve-spawn-invocation"

describe("resolveSpawnInvocation", () => {
  it("opens Windows terminals through cmd start so a console window appears", () => {
    expect(
      resolveSpawnInvocation({
        platform: "win32",
        kind: "terminal",
        command: "C:\\Windows\\System32\\wsl.exe",
        args: ["--cd", "E:\\code\\app"],
        cwd: "E:\\code\\app",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      })
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/c",
        "start",
        "",
        "/D",
        "E:\\code\\app",
        "C:\\Windows\\System32\\wsl.exe",
        "--cd",
        "E:\\code\\app",
      ],
    })
  })

  it("gives PowerShell a new console even when the folder is only the working directory", () => {
    expect(
      resolveSpawnInvocation({
        platform: "win32",
        kind: "terminal",
        command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-NoExit", "-NoLogo"],
        cwd: "E:\\code\\app",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      })
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/c",
        "start",
        "",
        "/D",
        "E:\\code\\app",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-NoExit",
        "-NoLogo",
      ],
    })
  })

  it("keeps Windows editor launches as the app executable", () => {
    expect(
      resolveSpawnInvocation({
        platform: "win32",
        kind: "editor",
        command: "C:\\Users\\ruanz\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
        args: ["E:\\code\\app"],
        cwd: "E:\\code\\app",
      })
    ).toEqual({
      command: "C:\\Users\\ruanz\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      args: ["E:\\code\\app"],
    })
  })

  it.each([
    {
      platform: "darwin",
      command: "open",
      args: ["-a", "Terminal"],
    },
    {
      platform: "linux",
      command: "gnome-terminal",
      args: ["--working-directory", "/tmp/app"],
    },
  ] as const)("does not wrap $platform terminals with cmd start", ({ platform, command, args }) => {
    expect(
      resolveSpawnInvocation({
        platform,
        kind: "terminal",
        command,
        args: [...args],
        cwd: "/tmp/app",
      })
    ).toEqual({ command, args: [...args] })
  })
})
