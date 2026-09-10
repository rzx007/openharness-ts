export const MAIN_WINDOW_LIGHT_BACKGROUND = "#f4f7f9"
export const MAIN_WINDOW_DARK_BACKGROUND = "#20242a"

export function mainWindowBackgroundColor(useDarkColors: boolean): string {
  return useDarkColors ? MAIN_WINDOW_DARK_BACKGROUND : MAIN_WINDOW_LIGHT_BACKGROUND
}
