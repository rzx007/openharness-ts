const largeHtmlLineThreshold = 5_000

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

export function shouldOfferHtmlBrowserOpen(path: string, content: string): boolean {
  if (!isHtmlPath(path)) return false

  let lineCount = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue
    lineCount += 1
    if (lineCount > largeHtmlLineThreshold) return true
  }
  return false
}
