const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"])

export function toExternalBrowserUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}
