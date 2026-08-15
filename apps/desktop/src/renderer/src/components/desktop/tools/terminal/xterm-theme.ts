import type { ITheme } from "@xterm/xterm"

const lightTheme: ITheme = {
  background: "#fbfcfc",
  foreground: "#1f2529",
  cursor: "#24292d",
  selectionBackground: "#cfd7df",
  black: "#24292d",
  red: "#c2410c",
  green: "#12805c",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#f6f8fa",
  brightBlack: "#6e7781",
  brightRed: "#d1242f",
  brightGreen: "#1a7f37",
  brightYellow: "#bf8700",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#ffffff",
}

const darkTheme: ITheme = {
  background: "#111417",
  foreground: "#dbe2e8",
  cursor: "#eef3f7",
  selectionBackground: "#39424c",
  black: "#1f2428",
  red: "#ff938a",
  green: "#6fdd8b",
  yellow: "#f0c36a",
  blue: "#6cb6ff",
  magenta: "#dcbdfb",
  cyan: "#76e3ea",
  white: "#dbe2e8",
  brightBlack: "#8b949e",
  brightRed: "#ffa198",
  brightGreen: "#7ee787",
  brightYellow: "#f2cc60",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#a5f3fc",
  brightWhite: "#ffffff",
}

export function getXtermTheme(): ITheme {
  return document.documentElement.classList.contains("dark") ? darkTheme : lightTheme
}
