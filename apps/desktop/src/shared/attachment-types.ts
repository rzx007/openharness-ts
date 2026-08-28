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
  intent: "auto"
  displayName: string
}

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
