import {
  APPEARANCE_STORAGE_KEY,
  parseAppearancePreferences,
} from "./components/appearance/appearance-preferences"

export function applyStartupTheme(root: HTMLElement = document.documentElement): void {
  try {
    const preferences = parseAppearancePreferences(localStorage.getItem(APPEARANCE_STORAGE_KEY))
    const prefersDark =
      typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    const resolved =
      preferences.theme === "system" ? (prefersDark ? "dark" : "light") : preferences.theme
    root.classList.remove("light", "dark")
    root.classList.add(resolved)
  } catch {
    // Keep the CSS prefers-color-scheme fallback if storage or parsing fails.
  }
}
