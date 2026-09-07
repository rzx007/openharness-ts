import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}))

import { workspaceService } from "./workspace-service"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("WorkspaceService.listFiles", () => {
  it("returns files beyond the former 5,000-entry boundary", async () => {
    const rootPath = await createTemporaryDirectory()
    await Promise.all(
      Array.from({ length: 5_001 }, (_, index) =>
        writeFile(join(rootPath, `file-${String(index).padStart(4, "0")}.txt`), "")
      )
    )

    const result = await workspaceService.listFiles({ rootPath })

    expect(result.entries).toHaveLength(5_001)
    expect(result.entries.at(-1)?.path).toBe("file-5000.txt")
  }, 90_000)

  it("keeps ignored directories out of the complete listing", async () => {
    const rootPath = await createTemporaryDirectory()
    await mkdir(join(rootPath, "node_modules"))
    await writeFile(join(rootPath, "node_modules", "ignored.js"), "")
    await writeFile(join(rootPath, "visible.ts"), "")

    const result = await workspaceService.listFiles({ rootPath })

    expect(result.entries.map((entry) => entry.path)).toEqual(["visible.ts"])
  })

  it("sorts directories before files and names within each group", async () => {
    const rootPath = await createTemporaryDirectory()
    await mkdir(join(rootPath, "z-directory"))
    await mkdir(join(rootPath, "a-directory"))
    await writeFile(join(rootPath, "z-file.ts"), "")
    await writeFile(join(rootPath, "a-file.ts"), "")

    const result = await workspaceService.listFiles({ rootPath })

    expect(result.entries.map((entry) => entry.path)).toEqual([
      "a-directory/",
      "z-directory/",
      "a-file.ts",
      "z-file.ts",
    ])
  })
})

describe("WorkspaceService.readFile extra-root", () => {
  it("reads a personal skill from an extra root", async () => {
    const project = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    const documentsPath = await createTemporaryDirectory()
    const skillPath = join(configDir, "skills", "show-me", "SKILL.md")
    await mkdir(join(configDir, "skills", "show-me"), { recursive: true })
    await writeFile(skillPath, "# skill\n")
    workspaceService.configureAllowedRoots({ configDir, documentsPath })

    const result = await workspaceService.readFile({
      rootPath: project,
      path: skillPath,
    })

    expect(result).toMatchObject({
      scope: "extra-root",
      relativePath: "skills/show-me/SKILL.md",
      rootLabel: "个人配置",
      content: "# skill\n",
    })
  })

  it("does not follow a symlink that escapes the allowed root", async () => {
    const project = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    const documentsPath = await createTemporaryDirectory()
    const outside = await createTemporaryDirectory()
    const target = join(outside, "secret.txt")
    await writeFile(target, "secret")
    const link = join(configDir, "skills", "leak.md")
    await mkdir(join(configDir, "skills"), { recursive: true })
    try {
      await symlink(target, link)
    } catch {
      return
    }
    workspaceService.configureAllowedRoots({ configDir, documentsPath })

    await expect(workspaceService.readFile({ rootPath: project, path: link })).rejects.toThrow(
      "文件必须位于当前项目目录内。"
    )
  })

  it("does not read credentials.json from the config directory", async () => {
    const project = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    await writeFile(join(configDir, "credentials.json"), "{\"token\":\"x\"}")
    workspaceService.configureAllowedRoots({
      configDir,
      documentsPath: await createTemporaryDirectory(),
    })

    await expect(
      workspaceService.readFile({
        rootPath: project,
        path: join(configDir, "credentials.json"),
      })
    ).rejects.toThrow()
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openharness-workspace-"))
  temporaryDirectories.push(path)
  return path
}
