import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { gitService } from "./git-service"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("gitService.fileDiff path containment", () => {
  it("rejects nested .. traversal that escapes the project root", async () => {
    const base = await mkdtemp(join(tmpdir(), "openharness-git-escape-"))
    temporaryRoots.push(base)
    const projectRoot = join(base, "project")
    const secretPath = join(base, "secret.txt")
    await mkdir(join(projectRoot, "src"), { recursive: true })
    await writeFile(secretPath, "TOP_SECRET_VALUE\n", "utf8")
    await writeFile(join(projectRoot, "src", "in-repo.txt"), "safe\n", "utf8")

    await expect(
      gitService.fileDiff({
        rootPath: projectRoot,
        path: "src/../../secret.txt",
        status: "untracked",
      })
    ).rejects.toThrow(/项目目录内/)

    await expect(
      gitService.fileDiff({
        rootPath: projectRoot,
        path: "src/./../../secret.txt",
        status: "untracked",
      })
    ).rejects.toThrow(/项目目录内/)
  })

  it("still reads an untracked file that stays inside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "openharness-git-ok-"))
    temporaryRoots.push(projectRoot)
    await mkdir(join(projectRoot, "src"), { recursive: true })
    await writeFile(join(projectRoot, "src", "notes.txt"), "hello from repo\n", "utf8")

    const result = await gitService.fileDiff({
      rootPath: projectRoot,
      path: "src/notes.txt",
      status: "untracked",
    })

    expect(result.path).toBe("src/notes.txt")
    expect(result.binary).toBe(false)
    expect(result.patch).toContain("+hello from repo")
  })
})
