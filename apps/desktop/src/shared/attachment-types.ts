import type { ServerCapabilities } from "@openharness/client"

type DesktopAttachmentLimits = NonNullable<ServerCapabilities["attachments"]>["limits"]

export interface DesktopAttachmentSupport {
  daemonSupported: boolean
  interactionEnabled: boolean
  uploadModes: readonly ("single" | "resumable")[]
  limits: DesktopAttachmentLimits | null
}

export interface DesktopAttachmentSupportEnvironment {
  isPackaged: boolean
  forceEnable: boolean
}

export type DesktopAttachmentDraftStatus = "uploading" | "ready" | "failed" | "cancelled"

export interface DesktopAttachmentError {
  code: string
  message: string
  retryable: boolean
}

export interface DesktopAttachmentCandidate {
  draftId: string
  sourceToken: string
  displayName: string
  declaredMediaType: string
  sizeBytes: number
}

export interface DesktopAttachmentDraft {
  draftId: string
  taskId: string
  displayName: string
  declaredMediaType: string
  sizeBytes: number
  status: DesktopAttachmentDraftStatus
  bytesUploaded: number
  progress: number | null
  assetId?: string
  mediaType?: string
  error?: DesktopAttachmentError
}

export interface DesktopPromptAttachmentInput {
  assetId: string
  intent: DesktopAttachmentIntent
  displayName: string
}

export type DesktopAttachmentIntent =
  "auto" | "vision" | "ocr" | "document" | "tool_resource" | "workspace_reference"

export interface StartDesktopAttachmentUploadInput {
  draftId: string
  taskId: string
  sourceToken: string
}

export interface UploadDesktopAttachmentMemoryInput {
  draftId: string
  taskId: string
  bytes: ArrayBuffer
  displayName: string
  mediaType: string
}

export interface RetryDesktopAttachmentUploadInput {
  draftId: string
  taskId: string
}

export interface DiscardDesktopAttachmentDraftInput {
  draftId: string
}

export interface CancelDesktopAttachmentUploadInput {
  taskId: string
}

export interface DesktopAttachmentAssetInput {
  assetId: string
}

export interface DesktopAttachmentPreview {
  bytes: Uint8Array
  mediaType: string
}

interface DesktopAttachmentUploadEventBase {
  draftId: string
  taskId: string
}

export type DesktopAttachmentUploadEvent =
  | (DesktopAttachmentUploadEventBase & {
      type: "progress"
      bytesRead: number
      totalBytes: number
    })
  | (DesktopAttachmentUploadEventBase & {
      type: "success"
      assetId: string
      displayName: string
      mediaType: string
      sizeBytes: number
    })
  | (DesktopAttachmentUploadEventBase & {
      type: "failed"
      error: DesktopAttachmentError
    })
  | (DesktopAttachmentUploadEventBase & {
      type: "cancelled"
    })

export function resolveDesktopAttachmentSupport(
  capabilities: ServerCapabilities,
  environment: DesktopAttachmentSupportEnvironment
): DesktopAttachmentSupport {
  const daemonSupported =
    (capabilities.features["attachments"] ?? 0) >= 1 && Boolean(capabilities.attachments)
  if (daemonSupported && capabilities.attachments) {
    return {
      daemonSupported: true,
      interactionEnabled: !environment.isPackaged || environment.forceEnable,
      uploadModes: capabilities.attachments.uploadModes,
      limits: capabilities.attachments.limits,
    }
  }
  return {
    daemonSupported: false,
    interactionEnabled: false,
    uploadModes: [],
    limits: null,
  }
}
