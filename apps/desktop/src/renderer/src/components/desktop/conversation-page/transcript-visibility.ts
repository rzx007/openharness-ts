import type { DesktopSessionPart } from "@shared/session-types"

export function visibleTranscriptParts(
  parts: DesktopSessionPart[],
  showReasoning: boolean
): DesktopSessionPart[] {
  if (showReasoning && !parts.some((part) => part.type === "transformation")) return parts

  return parts.filter(
    (part) => part.type !== "transformation" && (showReasoning || part.type !== "reasoning")
  )
}
