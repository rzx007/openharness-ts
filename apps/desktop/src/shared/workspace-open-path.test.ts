import { describe, expect, it } from "vitest"

import { toProjectRelativePath } from "./workspace-open-path"

const project = "E:/code/openharness-ts"

describe("toProjectRelativePath", () => {
  it("keeps project-relative paths including a leading slash", () => {
    expect(toProjectRelativePath("src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("/src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("./src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("src/foo.ts:12", project)).toBe("src/foo.ts")
  })

  it("strips a Windows project prefix", () => {
    expect(toProjectRelativePath("E:\\code\\openharness-ts\\src\\foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("\\\\?\\E:\\code\\openharness-ts\\src\\foo.ts", project)).toBe(
      "src/foo.ts"
    )
  })

  it("returns null for Windows paths outside the project", () => {
    expect(
      toProjectRelativePath(
        "C:\\Users\\ruanz\\.openharness-ts\\skills\\show-me\\SKILL.md",
        project
      )
    ).toBeNull()
  })

  it("does not treat a POSIX home path as a project-relative path", () => {
    expect(
      toProjectRelativePath("/Users/ruanz/.openharness-ts/skills/show-me/SKILL.md", project)
    ).toBe("Users/ruanz/.openharness-ts/skills/show-me/SKILL.md")
  })
})
