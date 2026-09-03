import type { AccentPresetId, AppearancePreferences } from "./appearance-preferences"
import { normalizeHexColor } from "./appearance-preferences"

export type AppearanceColorTokens = {
  primary: string
  primaryForeground: string
  ring: string
  accent: string
  accentForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarSelected: string
}

export const APPEARANCE_SURFACES = {
  light: { background: "#FCFCFC", sidebar: "#F0F6FA" },
  dark: { background: "#0A0A0A", sidebar: "#161B20" },
} as const

export const ACCENT_PRESET_COLORS: Record<AccentPresetId, `#${string}`> = {
  neutral: "#525252",
  blue: "#006AFF",
  violet: "#7C3AED",
  terracotta: "#B4533C",
  green: "#15803D",
}

type Rgb = { red: number; green: number; blue: number }

function hexToRgb(color: string): Rgb {
  const value = color.slice(1)
  return {
    red: Number.parseInt(value.slice(0, 2), 16),
    green: Number.parseInt(value.slice(2, 4), 16),
    blue: Number.parseInt(value.slice(4, 6), 16),
  }
}

function rgbToHex({ red, green, blue }: Rgb): `#${string}` {
  const channel = (value: number): string =>
    Math.round(Math.max(0, Math.min(255, value)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase()

  return `#${channel(red)}${channel(green)}${channel(blue)}`
}

function relativeLuminance(color: string): number {
  const { red, green, blue } = hexToRgb(color)
  const linearize = (channel: number): number => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }

  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)
}

export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function mixColors(from: string, to: string, toAmount: number): `#${string}` {
  const start = hexToRgb(from)
  const end = hexToRgb(to)
  return rgbToHex({
    red: start.red + (end.red - start.red) * toAmount,
    green: start.green + (end.green - start.green) * toAmount,
    blue: start.blue + (end.blue - start.blue) * toAmount,
  })
}

function chooseForeground(background: string): "#000000" | "#FFFFFF" {
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF"
}

function ensureSurfaceContrast(color: string, surface: string, minimumRatio: number): `#${string}` {
  if (contrastRatio(color, surface) >= minimumRatio) {
    return color as `#${string}`
  }

  const target =
    contrastRatio("#000000", surface) >= contrastRatio("#FFFFFF", surface) ? "#000000" : "#FFFFFF"
  let lower = 0
  let upper = 1

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (lower + upper) / 2
    if (contrastRatio(mixColors(color, target, middle), surface) >= minimumRatio) {
      upper = middle
    } else {
      lower = middle
    }
  }

  const adjusted = mixColors(color, target, upper)
  if (contrastRatio(adjusted, surface) >= minimumRatio) {
    return adjusted
  }

  return target
}

function resolveAccentColor(accent: AppearancePreferences["accent"]): `#${string}` {
  if (accent.kind === "preset") {
    return ACCENT_PRESET_COLORS[accent.id]
  }

  return normalizeHexColor(accent.value) ?? ACCENT_PRESET_COLORS.neutral
}

export function resolveAppearanceColors(
  accent: AppearancePreferences["accent"],
  theme: "light" | "dark"
): AppearanceColorTokens {
  const color = resolveAccentColor(accent)
  const surfaces = APPEARANCE_SURFACES[theme]
  const primary = ensureSurfaceContrast(color, surfaces.background, 3)
  const sidebarPrimary = ensureSurfaceContrast(color, surfaces.sidebar, 3)
  const ring = ensureSurfaceContrast(color, surfaces.background, 3)
  const accentStrength = theme === "light" ? 0.12 : 0.2
  const sidebarAccentStrength = theme === "light" ? 0.14 : 0.22
  const sidebarSelectedStrength = theme === "light" ? 0.1 : 0.2
  const weakAccent = mixColors(surfaces.background, color, accentStrength)
  const sidebarAccent = mixColors(surfaces.sidebar, color, sidebarAccentStrength)

  return {
    primary,
    primaryForeground: chooseForeground(primary),
    ring,
    accent: weakAccent,
    accentForeground: chooseForeground(weakAccent),
    sidebarPrimary,
    sidebarPrimaryForeground: chooseForeground(sidebarPrimary),
    sidebarAccent,
    sidebarAccentForeground: chooseForeground(sidebarAccent),
    sidebarSelected: mixColors(surfaces.sidebar, color, sidebarSelectedStrength),
  }
}
