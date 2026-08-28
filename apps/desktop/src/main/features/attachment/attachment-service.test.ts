import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AttachmentAssetRecord, UploadAttachmentInput } from "@openharness/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createAttachmentService,
  type AttachmentFileSystem,
  type DesktopAttachmentService,
} from "./attachment-service"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("DesktopAttachmentService source tokens", () => {
  it("keeps source tokens private to their owner and expires them on owner disposal", async () => {
    const filePath = await temporaryFile("private.txt", "secret")
    const service = createService()
    const [candidate] = await service.stagePaths(11, [filePath])

    await expect(
      service.startUpload(12, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_forbidden" })

    await service.disposeOwner(11)
    await expect(
      service.startUpload(11, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_expired" })
  })

  it("rejects directories and consumes a token only once", async () => {
    const root = await temporaryDirectory()
    const filePath = join(root, "once.txt")
    await writeFile(filePath, "one upload")
    const uploads: UploadAttachmentInput[] = []
    const service = createService({
      uploadAttachment: async (input) => {
        uploads.push(input)
        return readyAsset("asset-once", input.displayName, 10)
      },
    })

    await expect(service.stagePaths(1, [root])).rejects.toMatchObject({
      code: "attachment_source_not_file",
    })
    const [candidate] = await service.stagePaths(1, [filePath])
    await service.startUpload(1, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await expect(
      service.startUpload(1, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_expired" })
    await service.whenIdle()

    expect(uploads).toHaveLength(1)
  })

  it("rejects symbolic links, unreadable files, and naturally expired tokens", async () => {
    const symlinkService = createService({
      fileSystem: { lstat: async () => ({ isSymbolicLink: () => true }) },
    })
    await expect(symlinkService.stagePaths(1, ["symbolic-link"])).rejects.toMatchObject({
      code: "attachment_source_symlink",
    })
    const unreadableService = createService({
      fileSystem: {
        lstat: async () => ({ isSymbolicLink: () => false }),
        realpath: async () => "unreadable",
        stat: async () => ({ isFile: () => true, size: 1 }),
        assertReadable: async () => {
          throw new Error("denied")
        },
      },
    })
    await expect(unreadableService.stagePaths(1, ["unreadable"])).rejects.toMatchObject({
      code: "attachment_source_unreadable",
    })

    let now = 10_000
    const service = createService({ now: () => now })
    const filePath = await temporaryFile("expires.txt", "soon")
    const [candidate] = await service.stagePaths(1, [filePath])
    now = 100_001
    await expect(
      service.startUpload(1, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_expired" })
  })
})

describe("DesktopAttachmentService asset actions", () => {
  it("only previews safe bitmap media and enforces the preview byte limit", async () => {
    const downloadAttachment = vi.fn(async () => new Response(Uint8Array.of(1, 2, 3)))
    const getAttachment = vi.fn(async (id: string) => {
      if (id === "unsafe") return readyAsset(id, "page.html", 3, "text/html")
      if (id === "too-large") return readyAsset(id, "huge.png", 2_000_001, "image/png")
      return readyAsset(id, "image.png", 3, "image/png")
    })
    const service = createService({ getAttachment, downloadAttachment })

    await expect(service.readPreview("safe")).resolves.toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      mediaType: "image/png",
    })
    await expect(service.readPreview("unsafe")).rejects.toMatchObject({
      code: "attachment_preview_unsupported",
    })
    await expect(service.readPreview("too-large")).rejects.toMatchObject({
      code: "attachment_preview_too_large",
    })
    expect(downloadAttachment).toHaveBeenCalledTimes(1)
  })

  it("opens from its managed temporary directory, cleans it, and saves through a chosen path", async () => {
    const temporaryRoot = await temporaryDirectory()
    const savePath = join(temporaryRoot, "saved.txt")
    const openedPaths: string[] = []
    const service = createService({
      temporaryRoot,
      getAttachment: async (id) => readyAsset(id, "report.txt", 4),
      downloadAttachment: async () => new Response("data"),
      openPath: async (path) => {
        openedPaths.push(path)
        return ""
      },
      chooseSavePath: async () => savePath,
    })

    await service.openAttachment("asset-open")
    expect(openedPaths).toHaveLength(1)
    expect(openedPaths[0]!.startsWith(temporaryRoot)).toBe(true)
    await expect(access(openedPaths[0]!)).resolves.toBeUndefined()

    await expect(service.saveAs("asset-save")).resolves.toEqual({ saved: true })
    await expect(readFile(savePath, "utf8")).resolves.toBe("data")

    await service.cleanupTemporaryFiles()
    await expect(access(openedPaths[0]!)).rejects.toBeDefined()
  })

  it("treats attachment_in_use as an idempotent unreferenced cleanup result", async () => {
    const service = createService({
      deleteAttachment: async () => {
        throw { body: { error: { code: "attachment_in_use" } } }
      },
    })

    await expect(service.deleteUnreferenced("asset-used")).resolves.toEqual({
      deleted: false,
      inUse: true,
    })
  })
})

describe("DesktopAttachmentService uploads", () => {
  it("streams bytes, reports monotonic progress, and emits a ready asset", async () => {
    const filePath = await temporaryFile(
      "stream.bin",
      Uint8Array.from({ length: 192_000 }, (_, i) => i)
    )
    const events: Array<Record<string, unknown>> = []
    const service = createService({
      emit: (_ownerId, event) => events.push(event),
      uploadAttachment: async (input) => {
        const sizeBytes = await consume(input.body)
        return readyAsset("asset-stream", input.displayName, sizeBytes, "application/octet-stream")
      },
    })
    const [candidate] = await service.stagePaths(7, [filePath])
    const { taskId } = await service.startUpload(7, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await service.whenIdle()

    const progress = events.filter((event) => event.type === "progress")
    expect(progress.map((event) => event.bytesRead)).toEqual(
      [...progress.map((event) => event.bytesRead as number)].sort((a, b) => a - b)
    )
    expect(events.at(-1)).toMatchObject({
      type: "success",
      taskId,
      draftId: candidate!.draftId,
      assetId: "asset-stream",
      sizeBytes: 192_000,
    })
  })

  it("aborts a running task and ignores a client completion that arrives late", async () => {
    let resolveUpload!: (asset: AttachmentAssetRecord) => void
    let uploadSignal: AbortSignal | undefined
    const events: Array<Record<string, unknown>> = []
    const service = createService({
      emit: (_ownerId, event) => events.push(event),
      uploadAttachment: (input) => {
        uploadSignal = input.signal
        return new Promise((resolve) => {
          resolveUpload = resolve
        })
      },
    })
    const [candidate] = await service.stagePaths(9, [await temporaryFile("late.txt", "late")])
    const { taskId } = await service.startUpload(9, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await waitUntil(() => uploadSignal !== undefined)

    await service.cancelUpload(9, taskId)
    expect(uploadSignal!.aborted).toBe(true)
    resolveUpload(readyAsset("asset-too-late", "late.txt", 4))
    await service.whenIdle()

    expect(events).toContainEqual(expect.objectContaining({ type: "cancelled", taskId }))
    expect(events).not.toContainEqual(expect.objectContaining({ type: "success", taskId }))
  })

  it("runs at most three uploads and never opens a queued task cancelled by its owner", async () => {
    const files = await Promise.all(
      Array.from({ length: 5 }, (_, index) => temporaryFile(`queue-${index}.txt`, `${index}`))
    )
    let active = 0
    let maximumActive = 0
    const releases: Array<() => void> = []
    const opened: string[] = []
    const service = createService({
      onOpenSource: (path) => opened.push(path),
      uploadAttachment: async (input) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active -= 1
        return readyAsset(`asset-${input.displayName}`, input.displayName, 1)
      },
    })
    const candidates = await service.stagePaths(5, files)
    const tasks = await Promise.all(
      candidates.map((candidate) =>
        service.startUpload(5, {
          draftId: candidate.draftId,
          sourceToken: candidate.sourceToken,
        })
      )
    )
    await waitUntil(() => releases.length === 3)

    await service.cancelUpload(5, tasks[4]!.taskId)
    while (releases.length > 0) releases.shift()!()
    await waitUntil(() => releases.length === 1)
    while (releases.length > 0) releases.shift()!()
    await service.whenIdle()

    expect(maximumActive).toBe(3)
    expect(opened).not.toContain(files[4])
  })
})

function createService(
  overrides: {
    emit?: (ownerId: number, event: Record<string, unknown>) => void
    uploadAttachment?: (input: UploadAttachmentInput) => Promise<AttachmentAssetRecord>
    onOpenSource?: (path: string) => void
    now?: () => number
    getAttachment?: (id: string) => Promise<AttachmentAssetRecord>
    downloadAttachment?: (id: string) => Promise<Response>
    deleteAttachment?: (id: string) => Promise<AttachmentAssetRecord>
    temporaryRoot?: string
    openPath?: (path: string) => Promise<string>
    chooseSavePath?: (displayName: string) => Promise<string | null>
    fileSystem?: Partial<AttachmentFileSystem>
  } = {}
): DesktopAttachmentService {
  return createAttachmentService({
    sourceTokenTtlMs: 60_000,
    maxBytesPerFile: 2_000_000,
    emit: overrides.emit ?? (() => undefined),
    getClient: async () => ({
      uploadAttachment:
        overrides.uploadAttachment ??
        (async (input) => readyAsset("asset-default", input.displayName, 0)),
      getAttachment: overrides.getAttachment ?? vi.fn(),
      downloadAttachment: overrides.downloadAttachment ?? vi.fn(),
      deleteAttachment: overrides.deleteAttachment ?? vi.fn(),
    }),
    onOpenSource: overrides.onOpenSource,
    now: overrides.now,
    temporaryRoot: overrides.temporaryRoot,
    openPath: overrides.openPath,
    chooseSavePath: overrides.chooseSavePath,
    fileSystem: overrides.fileSystem,
  })
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openharness-attachment-"))
  temporaryDirectories.push(path)
  return path
}

async function temporaryFile(name: string, contents: string | Uint8Array): Promise<string> {
  const root = await temporaryDirectory()
  const path = join(root, name)
  await writeFile(path, contents)
  return path
}

function readyAsset(
  id: string,
  displayName: string,
  sizeBytes: number,
  mediaType = "text/plain"
): AttachmentAssetRecord {
  return {
    id,
    displayName,
    declaredMediaType: mediaType,
    mediaType,
    sizeBytes,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
  }
}

async function consume(body: UploadAttachmentInput["body"]): Promise<number> {
  if (!(body instanceof ReadableStream)) throw new Error("expected a ReadableStream")
  const reader = body.getReader()
  let size = 0
  for (;;) {
    const result = await reader.read()
    if (result.done) return size
    size += result.value.byteLength
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition was not met")
}
