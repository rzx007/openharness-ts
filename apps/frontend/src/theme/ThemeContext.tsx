import { createContext, useContext } from "react";

export interface Theme {
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    text: string;
    muted: string;
    error: string;
    success: string;
  };
}

const defaultTheme: Theme = {
  name: "default",
  colors: {
    primary: "cyan",
    secondary: "blue",
    accent: "magenta",
    text: "white",
    muted: "gray",
    error: "red",
    success: "green",
  },
};

export const ThemeContext = createContext<Theme>(defaultTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
