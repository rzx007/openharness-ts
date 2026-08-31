import type * as React from "react"
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Globe2,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react"
import { useRef } from "react"

import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"

import {
  browserTitleFromUrl,
  displayBrowserUrl,
  normalizeBrowserUrl,
  resolveExternalBrowserUrl,
} from "./browser-navigation"

export type BrowserToolTab = {
  id: string
  title: string
  url: string | null
  input: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type BrowserToolProps = {
  tab: BrowserToolTab
  active: boolean
  onUpdate: (patch: Partial<BrowserToolTab>) => void
}

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  stop?: () => void
  getURL?: () => string
  getTitle?: () => string
}

export function BrowserTool({ tab, active, onUpdate }: BrowserToolProps): React.JSX.Element {
  const webviewRef = useRef<BrowserWebviewElement | null>(null)

  const navigate = (): void => {
    const url = normalizeBrowserUrl(tab.input)
    if (!url) return
    onUpdate({
      url,
      input: displayBrowserUrl(url),
      title: browserTitleFromUrl(url),
      loading: true,
    })
  }

  const updateNavigationState = (): void => {
    const webview = webviewRef.current
    if (!webview) return
    const url = webview.getURL?.() ?? null
    const title = webview.getTitle?.() || (url ? browserTitleFromUrl(url) : "新标签页")
    onUpdate({
      title,
      url,
      input: url ? displayBrowserUrl(url) : "",
      loading: false,
      canGoBack: webview.canGoBack?.() ?? false,
      canGoForward: webview.canGoForward?.() ?? false,
    })
  }

  const bindWebview = (element: Element | null): void => {
    const webview = element as BrowserWebviewElement | null
    if (!webview || webviewRef.current === webview) return
    webviewRef.current = webview

    webview.addEventListener("did-start-loading", () => {
      onUpdate({ loading: true })
    })
    webview.addEventListener("did-stop-loading", updateNavigationState)
    webview.addEventListener("did-navigate", updateNavigationState)
    webview.addEventListener("did-navigate-in-page", updateNavigationState)
    webview.addEventListener("page-title-updated", (event) => {
      const title = (event as Event & { title?: string }).title
      if (title) onUpdate({ title })
    })
  }

  const getWebview = (): BrowserWebviewElement | null => webviewRef.current
  const externalUrl = resolveExternalBrowserUrl(tab.url ?? tab.input)

  const openInSystemBrowser = (): void => {
    if (!externalUrl) return
    void window.desktop.window.openExternal(externalUrl)
  }

  return (
    <section
      aria-hidden={!active}
      className={cn(
        "absolute inset-0 flex h-full min-h-0 flex-col bg-conversation transition-opacity duration-100",
        !active && "pointer-events-none opacity-0"
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="后退"
          aria-label="后退"
          disabled={!tab.canGoBack}
          onClick={() => getWebview()?.goBack?.()}
          className="text-muted-foreground"
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="前进"
          aria-label="前进"
          disabled={!tab.canGoForward}
          onClick={() => getWebview()?.goForward?.()}
          className="text-muted-foreground"
        >
          <ArrowRight />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={tab.loading ? "停止加载" : "刷新"}
          aria-label={tab.loading ? "停止加载" : "刷新"}
          onClick={() => (tab.loading ? getWebview()?.stop?.() : getWebview()?.reload?.())}
          className="text-muted-foreground"
        >
          <RefreshCw className={cn(tab.loading && "animate-spin")} />
        </Button>

        <form
          className="mx-3 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 focus-within:bg-muted/80"
          onSubmit={(event) => {
            event.preventDefault()
            navigate()
          }}
        >
          <SlidersHorizontal className="size-4 shrink-0 text-ui-muted" strokeWidth={1.7} />
          <input
            value={tab.input}
            onChange={(event) => onUpdate({ input: event.target.value })}
            placeholder="输入 URL 或本地路径"
            className="h-full min-w-0 flex-1 bg-transparent text-center text-[14px] text-ui-foreground outline-none placeholder:text-[12px]"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="在浏览器中打开"
            title="在浏览器中打开"
            disabled={!externalUrl}
            className="text-muted-foreground hover:bg-background"
            onClick={openInSystemBrowser}
          >
            <ArrowUpRight />
          </Button>
        </form>
      </div>

      <div className="relative min-h-0 flex-1 bg-background">
        {tab.url ? (
          <webview
            {...{
              ref: bindWebview,
              src: tab.url,
              partition: "persist:openharness-browser",
              className: "h-full w-full bg-background",
            }}
          />
        ) : (
          <DesktopEmptyState icon={Globe2} title="开始浏览" description="输入 URL 以打开页面" />
        )}
      </div>
    </section>
  )
}
