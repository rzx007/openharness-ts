export const minimumZoomLevel = -4
export const maximumZoomLevel = 6
export const actualSizeZoomLevel = 0

export function normalizeZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return actualSizeZoomLevel
  return Math.min(maximumZoomLevel, Math.max(minimumZoomLevel, Math.round(level)))
}

export function zoomLevelPercentage(level: number): number {
  return Math.round(100 * 1.2 ** normalizeZoomLevel(level))
}
