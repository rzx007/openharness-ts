import { describe, expect, it } from "vitest"

import type { AppearancePreferences } from "./appearance-preferences"
import { APPEARANCE_SURFACES, contrastRatio, resolveAppearanceColors } from "./appearance-colors"

const accents: AppearancePreferences["accent"][] = [
  { kind: "preset", id: "neutral" },
  { kind: "preset", id: "blue" },
  { kind: "preset", id: "violet" },
  { kind: "preset", id: "terracotta" },
  { kind: "preset", id: "green" },
  { kind: "custom", value: "#006AFF" },
  { kind: "custom", value: "#808080" },
  { kind: "custom", value: "#FFFF00" },
  { kind: "custom", value: "#050505" },
]

const tokenNames = [
  "accent",
  "accentForeground",
  "fileLink",
  "primary",
  "primaryForeground",
  "ring",
  "sidebarAccent",
  "sidebarAccentForeground",
  "sidebarPrimary",
  "sidebarPrimaryForeground",
  "sidebarSelected",
].sort()

describe("appearance color derivation", () => {
  it("keeps its test surfaces aligned with the base application surfaces", () => {
    expect(APPEARANCE_SURFACES).toEqual({
      light: { background: "#FCFCFC", sidebar: "#F0F6FA" },
      dark: { background: "#0A0A0A", sidebar: "#161B20" },
    })
  })

  it.each(["light", "dark"] as const)(
    "returns a complete, accessible token set in %s mode",
    (theme) => {
      const surfaces = APPEARANCE_SURFACES[theme]

      for (const accent of accents) {
        const tokens = resolveAppearanceColors(accent, theme)

        expect(Object.keys(tokens).sort()).toEqual(tokenNames)
        expect(tokens.fileLink).toBe(tokens.primary)
        expect(contrastRatio(tokens.primary, tokens.primaryForeground)).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastRatio(tokens.sidebarPrimary, tokens.sidebarPrimaryForeground)
        ).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(tokens.accent, tokens.accentForeground)).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastRatio(tokens.sidebarAccent, tokens.sidebarAccentForeground)
        ).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(tokens.primary, surfaces.background)).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(tokens.ring, surfaces.background)).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(tokens.sidebarPrimary, surfaces.sidebar)).toBeGreaterThanOrEqual(3)
      }
    }
  )

  it.each(["light", "dark"] as const)(
    "derives low-intensity selection colors instead of reusing the raw color in %s mode",
    (theme) => {
      const tokens = resolveAppearanceColors({ kind: "custom", value: "#006AFF" }, theme)

      expect(tokens.accent).not.toBe("#006AFF")
      expect(tokens.sidebarAccent).not.toBe("#006AFF")
      expect(tokens.sidebarSelected).not.toBe("#006AFF")
      expect(tokens.sidebarSelected).not.toBe(tokens.sidebarAccent)
    }
  )

  it.each([
    ["light", "#E0E6E9"],
    ["dark", "#22262A"],
  ] as const)("uses the C-level neutral selected color in %s mode", (theme, expected) => {
    expect(resolveAppearanceColors({ kind: "preset", id: "neutral" }, theme).sidebarSelected).toBe(
      expected
    )
  })

  it("calculates WCAG contrast ratios from sRGB colors", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21)
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.478, 3)
    expect(contrastRatio("#006AFF", "#FFFFFF")).toBeCloseTo(4.661, 3)
  })
})
