export function applyPreferredTerminalShell<T extends { runtime: string; shell?: string }>(
  input: T,
  preferredCommand: string | undefined,
  enabled = true
): T & { shell?: string } {
  if (input.shell?.trim()) return input
  if (!enabled || !preferredCommand) return input
  return { ...input, shell: preferredCommand }
}
