export const desktopShortcuts = {
  newConversation: { bindings: ["$mod+n"], keys: "N" },
  chooseProject: { bindings: ["$mod+o"], keys: "O" },
  closeConversation: { bindings: ["$mod+w"], keys: "W" },
  quit: { bindings: ["$mod+q"], keys: "Q" },
  toggleSidebar: { bindings: ["$mod+b"], keys: "B" },
  togglePanel: { bindings: ["$mod+j"], keys: "J" },
  openBrowser: { bindings: ["$mod+Shift+b"], keys: "Shift+B" },
  openFiles: { bindings: ["$mod+Shift+e"], keys: "Shift+E" },
  openTerminal: { bindings: ["$mod+Backquote"], keys: "`" },
  previousSession: { bindings: ["$mod+Shift+BracketLeft"], keys: "Shift+[" },
  nextSession: { bindings: ["$mod+Shift+BracketRight"], keys: "Shift+]" },
  goBack: { bindings: ["$mod+BracketLeft"], keys: "[" },
  goForward: { bindings: ["$mod+BracketRight"], keys: "]" },
  zoomIn: {
    bindings: ["$mod+Equal", "$mod+Shift+Equal", "$mod+NumpadAdd"],
    keys: "Shift+=",
  },
  zoomOut: { bindings: ["$mod+Minus", "$mod+NumpadSubtract"], keys: "-" },
  resetZoom: { bindings: ["$mod+Digit0", "$mod+Numpad0"], keys: "0" },
  showShortcuts: { bindings: ["$mod+Slash"], keys: "/" },
} as const

export type DesktopShortcutId = keyof typeof desktopShortcuts

export function shortcutLabel(id: DesktopShortcutId, isMac = false): string {
  return `${isMac ? "⌘" : "Ctrl"}+${desktopShortcuts[id].keys}`
}
