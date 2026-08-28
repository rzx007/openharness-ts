import { describe, expect, it } from "vitest"

import type {
  DesktopAttachmentCandidate,
  DesktopAttachmentUploadEvent,
} from "@shared/attachment-types"
import {
  NEW_CONVERSATION_SCOPE,
  addCandidates,
  applyUploadEvent,
  beginUpload,
  emptyComposerDraftState,
  findUploadEventScope,
  migrateComposerScope,
  removeDraftAttachment,
  resetComposerScope,
  selectDraftAttachments,
  selectDraftText,
  sessionComposerScope,
  setDraftText,
} from "./composer-draft-state"

const candidateA: DesktopAttachmentCandidate = {
  draftId: "draft-a",
  sourceToken: "source-a",
  displayName: "a.png",
  declaredMediaType: "image/png",
  sizeBytes: 10,
}

const candidateB: DesktopAttachmentCandidate = {
  draftId: "draft-b",
  sourceToken: "source-b",
  displayName: "b.pdf",
  declaredMediaType: "application/pdf",
  sizeBytes: 20,
}

describe("composer draft state", () => {
  it("isolates text and ordered attachments by composer scope", () => {
    const state = setDraftText(
      addCandidates(emptyComposerDraftState(), "session:a", [candidateA, candidateB]),
      "session:a",
      "A 的文字"
    )

    expect(selectDraftText(state, "session:a")).toBe("A 的文字")
    expect(selectDraftText(state, "session:b")).toBe("")
    expect(selectDraftAttachments(state, "session:a").map((item) => item.draftId)).toEqual([
      "draft-a",
      "draft-b",
    ])
    expect(selectDraftAttachments(state, "session:b")).toEqual([])
  })

  it("applies ready metadata only when scope, draft id, and current task id match", () => {
    const uploading = beginUpload(
      addCandidates(emptyComposerDraftState(), "session:a", [candidateA]),
      "session:a",
      candidateA.draftId,
      "task-new"
    )
    const lateFailure: DesktopAttachmentUploadEvent = {
      draftId: candidateA.draftId,
      taskId: "task-old",
      type: "failed",
      error: { code: "network", message: "late", retryable: true },
    }

    expect(applyUploadEvent(uploading, "session:a", lateFailure)).toBe(uploading)

    const ready = applyUploadEvent(uploading, "session:a", {
      draftId: candidateA.draftId,
      taskId: "task-new",
      type: "success",
      assetId: "asset-a",
      displayName: "safe-a.png",
      mediaType: "image/png",
      sizeBytes: 12,
    })
    expect(selectDraftAttachments(ready, "session:a")[0]).toMatchObject({
      status: "ready",
      assetId: "asset-a",
      displayName: "safe-a.png",
      mediaType: "image/png",
      sizeBytes: 12,
      bytesUploaded: 12,
      progress: 1,
    })
  })

  it("keeps order while removing one item and resetting only the requested scope", () => {
    const initial = addCandidates(
      addCandidates(emptyComposerDraftState(), "session:a", [candidateA, candidateB]),
      "session:b",
      [candidateB]
    )
    const removed = removeDraftAttachment(initial, "session:a", candidateA.draftId)
    const reset = resetComposerScope(removed, "session:a")

    expect(selectDraftAttachments(removed, "session:a").map((item) => item.draftId)).toEqual([
      candidateB.draftId,
    ])
    expect(selectDraftAttachments(reset, "session:a")).toEqual([])
    expect(selectDraftAttachments(reset, "session:b")).toHaveLength(1)
  })

  it("migrates a new-conversation draft atomically to a session scope", () => {
    const initial = setDraftText(
      addCandidates(emptyComposerDraftState(), NEW_CONVERSATION_SCOPE, [candidateA]),
      NEW_CONVERSATION_SCOPE,
      "第一条"
    )
    const target = sessionComposerScope("session-1")
    const migrated = migrateComposerScope(initial, NEW_CONVERSATION_SCOPE, target)

    expect(selectDraftText(migrated, NEW_CONVERSATION_SCOPE)).toBe("")
    expect(selectDraftAttachments(migrated, NEW_CONVERSATION_SCOPE)).toEqual([])
    expect(selectDraftText(migrated, target)).toBe("第一条")
    expect(selectDraftAttachments(migrated, target)).toHaveLength(1)
  })

  it("finds the owning scope only for the current task", () => {
    const state = beginUpload(
      addCandidates(emptyComposerDraftState(), "session:a", [candidateA]),
      "session:a",
      candidateA.draftId,
      "task-a"
    )

    expect(findUploadEventScope(state, candidateA.draftId, "task-a")).toBe("session:a")
    expect(findUploadEventScope(state, candidateA.draftId, "task-old")).toBeNull()
  })
})
