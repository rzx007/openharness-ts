export function applyPreferredTerminalShell<T extends { runtime: string; shell?: string }>(
  input: T,
  preferredCommand: string | undefined
): T {
  if (input.shell?.trim()) return input
  if (input.runtime !== "local" || !preferredCommand) return input
  return { ...input, shell: preferredCommand }
}
