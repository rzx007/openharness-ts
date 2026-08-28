interface ComposerClipboardData {
  files: ArrayLike<File>
  getData: (type: string) => string
}

export function readComposerClipboard(data: ComposerClipboardData): {
  files: File[]
  text: string
} {
  return {
    files: Array.from(data.files),
    text: data.getData("text/plain"),
  }
}

export function readComposerDrop(files: ArrayLike<File>): File[] {
  return Array.from(files)
}
