export type ThemeConfig = {
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    foreground: string;
    background: string;
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

export const defaultTheme: ThemeConfig = {
  name: "default",
  colors: {
    primary: "cyan",
    secondary: "white",
    accent: "cyan",
    foreground: "white",
    background: "black",
    muted: "gray",
    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",
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
};

export function getTheme(name: string): ThemeConfig {
  return BUILTIN_THEMES[name] ?? defaultTheme;
}
