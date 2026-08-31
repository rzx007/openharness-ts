import { fileURLToPath } from "node:url"

import { toExternalBrowserUrl } from "../../../shared/external-browser-url"

export type OpenExternalBrowserDeps = {
  openExternal: (url: string) => Promise<void>
  openPath: (path: string) => Promise<string>
}

export async function openUrlInDefaultBrowser(
  value: unknown,
  deps: OpenExternalBrowserDeps
): Promise<void> {
  const url = toExternalBrowserUrl(value)
  if (!url) throw new Error("无法在系统浏览器中打开该地址。")

  const parsed = new URL(url)
  if (parsed.protocol === "file:") {
    const error = await deps.openPath(fileURLToPath(url))
    if (error) throw new Error(error)
    return
  }

  await deps.openExternal(url)
}
