export type ThemeConfig = {
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    foreground: string;
    background: string;
    backgroundPanel: string;
    muted: string;
    success: string;
    warning: string;
    error: string;
    info: string;
  };
  icons: {
    spinner: string[];
    tool: string;
    assistant: string;
    user: string;
    system: string;
    success: string;
    error: string;
  };
};

/** One Dark — default dark theme */
export const defaultTheme: ThemeConfig = {
  name: "default",
  colors: {
    primary: "#56b6c2",
    secondary: "#abb2bf",
    accent: "#61afef",
    foreground: "#abb2bf",
    background: "#1e2127",
    backgroundPanel: "#262a33",
    muted: "#5c6370",
    success: "#98c379",
    warning: "#e5c07b",
    error: "#e06c75",
    info: "#61afef",
  },
  icons: {
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    tool: "  ⏵ ",
    assistant: "⏺ ",
    user: "> ",
    system: "ℹ ",
    success: "✓ ",
    error: "✗ ",
  },
};

/** GitHub Light — bright theme */
export const lightTheme: ThemeConfig = {
  name: "light",
  colors: {
    primary: "#0550ae",
    secondary: "#24292f",
    accent: "#0969da",
    foreground: "#24292f",
    background: "#ffffff",
    backgroundPanel: "#f6f8fa",
    muted: "#6e7781",
    success: "#1a7f37",
    warning: "#9a6700",
    error: "#cf222e",
    info: "#0969da",
  },
  icons: {
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    tool: "  ⏵ ",
    assistant: "⏺ ",
    user: "> ",
    system: "ℹ ",
    success: "✓ ",
    error: "✗ ",
  },
};

/** Dracula — high-contrast dark theme */
export const draculaTheme: ThemeConfig = {
  name: "dracula",
  colors: {
    primary: "#bd93f9",
    secondary: "#f8f8f2",
    accent: "#8be9fd",
    foreground: "#f8f8f2",
    background: "#282a36",
    backgroundPanel: "#343746",
    muted: "#6272a4",
    success: "#50fa7b",
    warning: "#ffb86c",
    error: "#ff5555",
    info: "#8be9fd",
  },
  icons: {
    spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    tool: "  ⏵ ",
    assistant: "⏺ ",
    user: "> ",
    system: "ℹ ",
    success: "✓ ",
    error: "✗ ",
  },
};

export const BUILTIN_THEMES: Record<string, ThemeConfig> = {
  default: defaultTheme,
  light: lightTheme,
  dracula: draculaTheme,
};

export function getTheme(name: string): ThemeConfig {
  return BUILTIN_THEMES[name] ?? defaultTheme;
}
