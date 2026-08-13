/**
 * Read-only selectors over the reducer state.
 *
 * These stay UI-agnostic so TUI/Web/Desktop can share the canonical
 * message/part view and map it to their own presentation models.
 */

import type { SessionBucket, SessionMessagePartRecord, SessionMessageRecord } from "../types/index.js";

export interface SessionMessageWithParts {
  message: SessionMessageRecord;
  parts: SessionMessagePartRecord[];
}

export function selectSessionMessagesWithParts(
  bucket: SessionBucket | undefined,
): SessionMessageWithParts[] {
  if (!bucket) return [];
  return [...bucket.messages]
    .sort((a, b) => a.seq - b.seq)
    .map((message) => ({
      message,
      parts: [...(bucket.partsByMessageId[message.id] ?? [])].sort((a, b) => a.seq - b.seq),
    }));
}
