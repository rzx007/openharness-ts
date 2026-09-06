export function toProjectRelativePath(
  path: string,
  projectPath: string | undefined
): string | null {
  const withoutLocation = path.trim().replace(/:(\d+)(?::\d+)?$/, "")
  const normalizedPath = stripExtendedPrefix(withoutLocation.replace(/\\/g, "/"))
  const normalizedProject = projectPath?.replace(/\\/g, "/").replace(/\/$/, "")

  if (isWindowsAbsolutePath(normalizedPath)) {
    if (!normalizedProject) return null
    const projectPrefix = `${normalizedProject.toLocaleLowerCase()}/`
    if (!normalizedPath.toLocaleLowerCase().startsWith(projectPrefix)) return null
    return normalizedPath.slice(normalizedProject.length + 1)
  }

  return normalizedPath.replace(/^\.\//, "").replace(/^\//, "")
}

function stripExtendedPrefix(path: string): string {
  return path.replace(/^\/\/\?\//, "")
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith("//")
}
