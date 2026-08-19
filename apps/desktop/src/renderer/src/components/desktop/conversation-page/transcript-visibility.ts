import type { DesktopSessionPart } from "@shared/session-types"

export function visibleTranscriptParts(
  parts: DesktopSessionPart[],
  showReasoning: boolean
): DesktopSessionPart[] {
  return showReasoning ? parts : parts.filter((part) => part.type !== "reasoning")
}
