export function scheduleProviderNoticeDismissal(clear: () => void, delayMs: number): () => void {
  const timeout = setTimeout(clear, delayMs)
  return () => clearTimeout(timeout)
}
