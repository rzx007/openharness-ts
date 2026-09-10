import type { DesktopSessionPart } from "@shared/session-types"

export function messageTextContent(parts: DesktopSessionPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
}
