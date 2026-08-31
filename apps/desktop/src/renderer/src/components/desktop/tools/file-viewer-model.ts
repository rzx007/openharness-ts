import type { PreviewDecision } from "./file-preview-policy"

export function resolveMarkdownRenderMode(
  decision: PreviewDecision,
  forcePreview: boolean
): "preview" | "paused" {
  return forcePreview || decision.mode !== "paused" ? "preview" : "paused"
}
