export function openTerminalWebLink(uri: string): void {
  void window.desktop.window.openExternal(uri)
}
