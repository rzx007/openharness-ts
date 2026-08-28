import { Download, ExternalLink, FileImage, FileText } from "lucide-react"
import { useEffect, useState } from "react"

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@renderer/components/ui/attachment"
import type {
  DesktopAttachmentSessionPart,
  DesktopTransformationSessionPart,
} from "@shared/session-types"

const safePreviewMediaTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])

export function MessageAttachment({
  part,
  readOnly = false,
}: {
  part: DesktopAttachmentSessionPart
  readOnly?: boolean
}): React.JSX.Element {
  const previewUrl = useMessageAttachmentPreview(part)
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)
  const visiblePreviewUrl = previewUrl && previewUrl !== failedPreviewUrl ? previewUrl : null
  return (
    <Attachment state="done" size="sm" className="max-w-72 flex-nowrap">
      <AttachmentMedia variant={visiblePreviewUrl ? "image" : "icon"}>
        {visiblePreviewUrl ? (
          <img
            src={visiblePreviewUrl}
            alt=""
            onError={() => setFailedPreviewUrl(visiblePreviewUrl)}
          />
        ) : part.mediaType.startsWith("image/") ? (
          <FileImage />
        ) : (
          <FileText />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={part.displayName}>{part.displayName}</AttachmentTitle>
        <AttachmentDescription>
          {fileKind(part.mediaType)} · {formatBytes(part.sizeBytes)}
        </AttachmentDescription>
      </AttachmentContent>
      {!readOnly ? (
        <AttachmentActions>
          <AttachmentAction
            aria-label={`打开 ${part.displayName}`}
            title="打开"
            onClick={() => void window.desktop.attachments.open({ assetId: part.assetId })}
          >
            <ExternalLink />
          </AttachmentAction>
          <AttachmentAction
            aria-label={`另存为 ${part.displayName}`}
            title="另存为"
            onClick={() => void window.desktop.attachments.saveAs({ assetId: part.assetId })}
          >
            <Download />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  )
}

export function MessageTransformation({
  part,
}: {
  part: DesktopTransformationSessionPart
}): React.JSX.Element {
  const failed = part.status === "failed" || Boolean(part.transformationError)
  const processing = part.status === "pending" || part.status === "running"
  return (
    <Attachment state={failed ? "error" : processing ? "processing" : "done"} size="xs">
      <AttachmentMedia variant="icon">
        <FileText />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>
          {processing ? "正在处理附件" : failed ? "附件处理失败" : "附件已处理"}
        </AttachmentTitle>
        <AttachmentDescription aria-live={failed ? "polite" : undefined}>
          {part.transformationError ?? transformationLabel(part.kind)}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  )
}

function useMessageAttachmentPreview(part: DesktopAttachmentSessionPart): string | null {
  const [preview, setPreview] = useState<{ assetId: string; url: string } | null>(null)
  const previewable = safePreviewMediaTypes.has(part.mediaType)

  useEffect(() => {
    if (!previewable) return
    let disposed = false
    let objectUrl: string | null = null
    void window.desktop.attachments
      .readPreview({ assetId: part.assetId })
      .then((result) => {
        if (disposed) return
        if (!safePreviewMediaTypes.has(result.mediaType)) {
          setPreview(null)
          return
        }
        objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mediaType }))
        setPreview({ assetId: part.assetId, url: objectUrl })
      })
      .catch(() => {
        if (!disposed) setPreview(null)
      })
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [part.assetId, previewable])

  return previewable && preview?.assetId === part.assetId ? preview.url : null
}

function fileKind(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "图片"
  if (mediaType.includes("pdf")) return "PDF"
  if (mediaType.startsWith("text/")) return "文本"
  return "文件"
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function transformationLabel(kind: DesktopTransformationSessionPart["kind"]): string {
  if (kind === "document_extract") return "文档内容"
  if (kind === "tool_mount") return "工具资源"
  return "直接使用"
}
