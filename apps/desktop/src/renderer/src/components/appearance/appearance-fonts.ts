import type { AppearancePreferences, CodeFontId, UiFontId } from "./appearance-preferences"

export type AppearanceFontOption<Id extends string> = {
  id: Id
  label: string
  source: "bundled" | "system-generic" | "local"
  family: string
  checkQuery?: string
}

export const UI_FONT_OPTIONS: readonly AppearanceFontOption<UiFontId>[] = [
  {
    id: "system",
    label: "系统默认",
    source: "system-generic",
    family: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
  },
  {
    id: "inter",
    label: "Inter",
    source: "bundled",
    family: '"Inter Variable", Inter, sans-serif',
  },
  {
    id: "segoe-ui",
    label: "Segoe UI",
    source: "local",
    family: '"Segoe UI Variable Text", "Segoe UI", sans-serif',
    checkQuery: '12px "Segoe UI Variable Text"',
  },
]

export const CODE_FONT_OPTIONS: readonly AppearanceFontOption<CodeFontId>[] = [
  {
    id: "geist-mono",
    label: "Geist Mono",
    source: "bundled",
    family: '"Geist Mono Variable", monospace',
  },
  {
    id: "cascadia-code",
    label: "Cascadia Code",
    source: "local",
    family: '"Cascadia Code", "Geist Mono Variable", Consolas, monospace',
    checkQuery: '12px "Cascadia Code"',
  },
  {
    id: "cascadia-mono",
    label: "Cascadia Mono",
    source: "local",
    family: '"Cascadia Mono", "Geist Mono Variable", Consolas, monospace',
    checkQuery: '12px "Cascadia Mono"',
  },
  {
    id: "consolas",
    label: "Consolas",
    source: "local",
    family: 'Consolas, "Geist Mono Variable", monospace',
    checkQuery: '12px "Consolas"',
  },
]

const ALL_FONT_OPTIONS: readonly AppearanceFontOption<string>[] = [
  ...UI_FONT_OPTIONS,
  ...CODE_FONT_OPTIONS,
]

export async function detectLocalFontAvailability(
  check: (query: string) => boolean
): Promise<Record<string, boolean>> {
  const availability: Record<string, boolean> = {}

  for (const option of ALL_FONT_OPTIONS) {
    if (option.source !== "local" || !option.checkQuery) {
      continue
    }

    try {
      availability[option.id] = check(option.checkQuery)
    } catch {
      availability[option.id] = false
    }
  }

  return availability
}

function isUnavailableLocalFont(
  option: AppearanceFontOption<string>,
  availability: Readonly<Record<string, boolean>>
): boolean {
  return option.source === "local" && availability[option.id] === false
}

export function repairUnavailableFonts(
  preferences: AppearancePreferences,
  availability: Readonly<Record<string, boolean>>
): AppearancePreferences {
  const selectedUiFont = UI_FONT_OPTIONS.find((option) => option.id === preferences.uiFont)
  const selectedCodeFont = CODE_FONT_OPTIONS.find((option) => option.id === preferences.codeFont)
  const repairUiFont = selectedUiFont && isUnavailableLocalFont(selectedUiFont, availability)
  const repairCodeFont = selectedCodeFont && isUnavailableLocalFont(selectedCodeFont, availability)

  if (!repairUiFont && !repairCodeFont) {
    return preferences
  }

  return {
    ...preferences,
    uiFont: repairUiFont ? "inter" : preferences.uiFont,
    codeFont: repairCodeFont ? "geist-mono" : preferences.codeFont,
  }
}
