export function nextExplicitTheme(resolvedTheme: "light" | "dark"): "light" | "dark" {
  return resolvedTheme === "dark" ? "light" : "dark"
}
