export function resolveDraftAfterSubmission(
  currentDraft: string,
  submittedContent: string,
  completedSessionId: string | null,
  currentSessionId: string | null
): string {
  return completedSessionId !== null &&
    currentDraft.trim() === submittedContent &&
    currentSessionId === completedSessionId
    ? ""
    : currentDraft
}
