import type { UiNode } from "../types/ui";
import { createContext, useContext, useState } from "react";
import { type ThemeConfig, BUILTIN_THEMES, defaultTheme, getTheme } from "./builtinThemes";

export type { ThemeConfig };

type ThemeContextValue = {
  theme: ThemeConfig;
  setThemeName: (name: string) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: defaultTheme,
  setThemeName: () => undefined,
});

export function ThemeProvider({
  children,
  initialTheme = "default",
}: {
  children: UiNode;
  initialTheme?: string;
}) {
  const [theme, setTheme] = useState<ThemeConfig>(() => getTheme(initialTheme));

  const setThemeName = (name: string): void => {
    const resolved = BUILTIN_THEMES[name] ?? defaultTheme;
    setTheme(resolved);
  };

  return (
    <ThemeContext.Provider value={{ theme, setThemeName }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
