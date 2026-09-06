export function prepareFileOpenRequest(
  rawPath: string,
  _projectPath: string | undefined
): { openPath: string; placeholderPath: string | null } {
  return { openPath: rawPath.trim(), placeholderPath: null }
}
