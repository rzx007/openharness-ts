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

import { cn } from "@renderer/lib/utils"

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
    const url = normalizeUrl(tab.input)
    if (!url) return
    onUpdate({ url, input: displayUrl(url), title: titleFromUrl(url), loading: true })
  }

  const updateNavigationState = (): void => {
    const webview = webviewRef.current
    if (!webview) return
    const url = webview.getURL?.() ?? null
    const title = webview.getTitle?.() || (url ? titleFromUrl(url) : "新标签页")
    onUpdate({
      title,
      url,
      input: url ? displayUrl(url) : "",
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

  return (
    <section
      aria-hidden={!active}
      className={cn(
        "absolute inset-0 flex h-full min-h-0 flex-col bg-panel transition-opacity duration-100",
        !active && "pointer-events-none opacity-0"
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-3">
        <BrowserButton
          label="后退"
          disabled={!tab.canGoBack}
          onClick={() => getWebview()?.goBack?.()}
        >
          <ArrowLeft />
        </BrowserButton>
        <BrowserButton
          label="前进"
          disabled={!tab.canGoForward}
          onClick={() => getWebview()?.goForward?.()}
        >
          <ArrowRight />
        </BrowserButton>
        <BrowserButton
          label={tab.loading ? "停止加载" : "刷新"}
          onClick={() => (tab.loading ? getWebview()?.stop?.() : getWebview()?.reload?.())}
        >
          <RefreshCw className={cn(tab.loading && "animate-spin")} />
        </BrowserButton>

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
            placeholder="输入 URL"
            className="h-full min-w-0 flex-1 bg-transparent text-center text-[14px] text-ui-foreground outline-none placeholder:text-[12px]"
          />
          <button
            type="button"
            aria-label="在浏览器中打开"
            title="在浏览器中打开"
            className="grid size-6 place-items-center rounded-md text-ui-muted hover:bg-background hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
          >
            <ArrowUpRight />
          </button>
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
          <BrowserEmptyState />
        )}
      </div>
    </section>
  )
}

function BrowserButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-ui-muted transition-colors hover:bg-muted hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

function BrowserEmptyState(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <Globe2 className="mb-4 size-10 text-ui-muted" strokeWidth={1.6} />
      <h2 className="text-[17px] font-semibold text-ui-foreground">开始浏览</h2>
      <p className="mt-2 text-[13px] text-ui-muted">输入 URL 以打开页面</p>
    </div>
  )
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^localhost(?::\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host + parsed.pathname.replace(/\/$/, "") + parsed.search
  } catch {
    return url
  }
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname || "新标签页"
  } catch {
    return "新标签页"
  }
}
