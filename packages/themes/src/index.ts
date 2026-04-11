export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
  muted: string;
  error: string;
  success: string;
  warning: string;
  border: string;
}

export interface ThemeDefinition {
  name: string;
  displayName: string;
  colors: ThemeColors;
  fontFamily?: string;
  fontSize?: number;
}

export {
  defaultTheme,
  darkTheme,
  minimalTheme,
  cyberpunkTheme,
  solarizedTheme,
  builtinThemes,
} from "./builtin";

import { builtinThemes } from "./builtin";

export class ThemeManager {
  private themes = new Map<string, ThemeDefinition>();
  private activeTheme: string;

  constructor() {
    for (const theme of builtinThemes) {
      this.themes.set(theme.name, theme);
    }
    this.activeTheme = "default";
  }

  register(theme: ThemeDefinition): void {
    this.themes.set(theme.name, theme);
  }

  get(name: string): ThemeDefinition | undefined {
    return this.themes.get(name);
  }

  setActive(name: string): boolean {
    if (!this.themes.has(name)) return false;
    this.activeTheme = name;
    return true;
  }

  getActive(): ThemeDefinition {
    const theme = this.themes.get(this.activeTheme);
    if (!theme) throw new Error(`Active theme "${this.activeTheme}" not found`);
    return theme;
  }

  list(): ThemeDefinition[] {
    return [...this.themes.values()];
  }
}
