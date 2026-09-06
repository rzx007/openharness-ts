export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes("Cannot update daemon settings while session runs are active")) {
    return "当前有任务正在运行。请等待任务结束或停止任务后，再修改该设置。"
  }
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error|OpenHarnessApiError): /, "")
}
