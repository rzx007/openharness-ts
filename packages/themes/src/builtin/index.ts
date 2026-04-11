import type { ThemeDefinition } from "../index";

export const defaultTheme: ThemeDefinition = {
  name: "default",
  displayName: "Default",
  colors: {
    primary: "#2563eb",
    secondary: "#64748b",
    accent: "#8b5cf6",
    background: "#ffffff",
    foreground: "#0f172a",
    muted: "#94a3b8",
    error: "#dc2626",
    success: "#16a34a",
    warning: "#d97706",
    border: "#e2e8f0",
  },
};

export const darkTheme: ThemeDefinition = {
  name: "dark",
  displayName: "Dark",
  colors: {
    primary: "#3b82f6",
    secondary: "#94a3b8",
    accent: "#a78bfa",
    background: "#0f172a",
    foreground: "#f1f5f9",
    muted: "#64748b",
    error: "#f87171",
    success: "#4ade80",
    warning: "#fbbf24",
    border: "#334155",
  },
};

export const minimalTheme: ThemeDefinition = {
  name: "minimal",
  displayName: "Minimal",
  colors: {
    primary: "#000000",
    secondary: "#666666",
    accent: "#333333",
    background: "#ffffff",
    foreground: "#000000",
    muted: "#999999",
    error: "#cc0000",
    success: "#008800",
    warning: "#cc8800",
    border: "#cccccc",
  },
};

export const cyberpunkTheme: ThemeDefinition = {
  name: "cyberpunk",
  displayName: "Cyberpunk",
  colors: {
    primary: "#ff00ff",
    secondary: "#00ffff",
    accent: "#ff0080",
    background: "#0a0a0f",
    foreground: "#e0e0ff",
    muted: "#6666aa",
    error: "#ff0040",
    success: "#00ff80",
    warning: "#ffaa00",
    border: "#330066",
  },
};

export const solarizedTheme: ThemeDefinition = {
  name: "solarized",
  displayName: "Solarized",
  colors: {
    primary: "#268bd2",
    secondary: "#657b83",
    accent: "#d33682",
    background: "#fdf6e3",
    foreground: "#073642",
    muted: "#93a1a1",
    error: "#dc322f",
    success: "#859900",
    warning: "#b58900",
    border: "#eee8d5",
  },
};

export const builtinThemes: ThemeDefinition[] = [
  defaultTheme,
  darkTheme,
  minimalTheme,
  cyberpunkTheme,
  solarizedTheme,
];
