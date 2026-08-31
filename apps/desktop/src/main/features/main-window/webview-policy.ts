export function isAllowedWebviewUrl(value: string | undefined): boolean {
  if (!value) return true
  if (value === "about:blank") return true
  try {
    const url = new URL(value)
    return ["http:", "https:", "data:", "file:"].includes(url.protocol)
  } catch {
    return false
  }
}
