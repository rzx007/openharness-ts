import { describe, expect, it } from "vitest"

import {
  actualSizeZoomLevel,
  maximumZoomLevel,
  minimumZoomLevel,
  normalizeZoomLevel,
  zoomLevelPercentage,
} from "./zoom"

describe("desktop zoom", () => {
  it("clamps and rounds requested zoom levels", () => {
    expect(normalizeZoomLevel(-99)).toBe(minimumZoomLevel)
    expect(normalizeZoomLevel(99)).toBe(maximumZoomLevel)
    expect(normalizeZoomLevel(1.6)).toBe(2)
    expect(normalizeZoomLevel(Number.NaN)).toBe(actualSizeZoomLevel)
  })

  it("converts Chromium zoom levels to percentages", () => {
    expect(zoomLevelPercentage(0)).toBe(100)
    expect(zoomLevelPercentage(1)).toBe(120)
    expect(zoomLevelPercentage(-1)).toBe(83)
  })
})
