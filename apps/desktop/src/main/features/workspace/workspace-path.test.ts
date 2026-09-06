import { posix, win32 } from "node:path"
import { describe, expect, it } from "vitest"

import { classifyWorkspacePath } from "./workspace-path"

const windowsRoots = {
  projectRoot: "E:\\code\\openharness-ts",
  configDir: "C:\\Users\\ruanz\\.openharness-ts",
  skillsDir: "C:\\Users\\ruanz\\.openharness-ts\\skills",
  userProfilePath: "C:\\Users\\ruanz\\.openharness-ts\\USER.md",
  outsideProjectRoot: "C:\\Users\\ruanz\\Documents\\OpenHarness",
}

const posixRoots = {
  projectRoot: "/repo",
  configDir: "/Users/ruanz/.openharness-ts",
  skillsDir: "/Users/ruanz/.openharness-ts/skills",
  userProfilePath: "/Users/ruanz/.openharness-ts/USER.md",
  outsideProjectRoot: "/Users/ruanz/Documents/OpenHarness",
}

describe("classifyWorkspacePath", () => {
  it("classifies project-relative and in-project Windows absolute paths", () => {
    expect(classifyWorkspacePath("src/a.ts", windowsRoots, { win32, posix })?.kind).toBe("project")
    expect(
      classifyWorkspacePath("E:\\code\\openharness-ts\\src\\a.ts", windowsRoots, { win32, posix })
        ?.relativePath
    ).toBe("src/a.ts")
  })

  it("classifies personal skills and USER.md as extra-root", () => {
    const skill = classifyWorkspacePath(
      "C:\\Users\\ruanz\\.openharness-ts\\skills\\show-me\\SKILL.md",
      windowsRoots,
      { win32, posix }
    )
    expect(skill).toMatchObject({
      kind: "extra-root",
      relativePath: "skills/show-me/SKILL.md",
      rootLabel: "个人配置",
    })
    expect(
      classifyWorkspacePath("C:\\Users\\ruanz\\.openharness-ts\\USER.md", windowsRoots, {
        win32,
        posix,
      })?.kind
    ).toBe("extra-root")
    expect(
      classifyWorkspacePath("C:\\Users\\ruanz\\.openharness-ts\\credentials.json", windowsRoots, {
        win32,
        posix,
      })
    ).toBeNull()
  })

  it("maps POSIX skill paths using each root drive, not the process drive", () => {
    const result = classifyWorkspacePath(
      "/Users/ruanz/.openharness-ts/skills/show-me/SKILL.md",
      windowsRoots,
      { win32, posix }
    )
    expect(result?.kind).toBe("extra-root")
    expect(result?.tabPath.replace(/\\/g, "/")).toContain(
      "C:/Users/ruanz/.openharness-ts/skills/show-me/SKILL.md"
    )
  })

  it("falls back /src/foo.ts to a project-relative path", () => {
    expect(classifyWorkspacePath("/src/foo.ts", windowsRoots, { win32, posix })).toMatchObject({
      kind: "project",
      relativePath: "src/foo.ts",
    })
  })

  it("does not classify /etc/passwd as extra-root", () => {
    expect(classifyWorkspacePath("/etc/passwd", posixRoots, { win32, posix })?.kind).not.toBe(
      "extra-root"
    )
    expect(classifyWorkspacePath("/etc/passwd", posixRoots, { win32, posix })).toMatchObject({
      kind: "project",
      relativePath: "etc/passwd",
    })
  })

  it("prefers the current project when it sits inside an extra root", () => {
    const sessionRoots = {
      ...windowsRoots,
      projectRoot: "C:\\Users\\ruanz\\Documents\\OpenHarness\\2026-09-06\\x1",
    }
    expect(
      classifyWorkspacePath(
        "C:\\Users\\ruanz\\Documents\\OpenHarness\\2026-09-06\\x1\\src\\a.ts",
        sessionRoots,
        { win32, posix }
      )
    ).toMatchObject({ kind: "project", relativePath: "src/a.ts" })
    expect(
      classifyWorkspacePath(
        "C:\\Users\\ruanz\\Documents\\OpenHarness\\2026-09-06\\x2\\note.md",
        sessionRoots,
        { win32, posix }
      )?.kind
    ).toBe("extra-root")
  })
})
