import { Check, Copy, Download, TriangleAlert } from "lucide-react"
import mermaid from "mermaid"
import { useEffect, useId, useMemo, useState } from "react"

import { Spinner } from "@renderer/components/ui/spinner"

type MermaidRenderState =
  | { status: "idle"; svg: null; error: null }
  | { status: "loading"; svg: null; error: null }
  | { status: "success"; svg: string; error: null }
  | { status: "error"; svg: null; error: string }

interface MermaidDiagramProps {
  code: string
  isIncomplete: boolean
}

export function MermaidDiagram({ code, isIncomplete }: MermaidDiagramProps): React.JSX.Element {
  const reactId = useId()
  const theme = useMermaidTheme()
  const [copied, setCopied] = useState(false)
  const [state, setState] = useState<MermaidRenderState>({
    status: "idle",
    svg: null,
    error: null,
  })

  const source = useMemo(() => code.trim(), [code])
  const diagramId = useMemo(
    () => `openharness-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}-${hashString(source)}`,
    [reactId, source]
  )

  useEffect(() => {
    setCopied(false)
  }, [source])

  useEffect(() => {
    if (!source) {
      setState({ status: "idle", svg: null, error: null })
      return
    }

    if (isIncomplete) {
      setState({ status: "loading", svg: null, error: null })
      return
    }

    let cancelled = false
    setState({ status: "loading", svg: null, error: null })

    mermaid.initialize({
      flowchart: { htmlLabels: false },
      securityLevel: "strict",
      startOnLoad: false,
      theme,
    })

    void mermaid
      .render(diagramId, source)
      .then(({ svg }) => {
        if (!cancelled) setState({ status: "success", svg, error: null })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!cancelled) setState({ status: "error", svg: null, error: message })
      })

    return () => {
      cancelled = true
    }
  }, [diagramId, isIncomplete, source, theme])

  const copySvg = async (): Promise<void> => {
    if (state.status !== "success") return
    await navigator.clipboard.writeText(state.svg)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const downloadSvg = (): void => {
    if (state.status !== "success") return
    const blob = new Blob([state.svg], { type: "image/svg+xml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "diagram.svg"
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <figure className="assistant-mermaid group/mermaid">
      {state.status === "success" ? (
        <>
          <div className="assistant-mermaid-controls">
            <button
              type="button"
              title={copied ? "Copied SVG" : "Copy SVG"}
              onClick={() => void copySvg()}
              className="assistant-mermaid-control"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            <button
              type="button"
              title="Download SVG"
              onClick={downloadSvg}
              className="assistant-mermaid-control"
            >
              <Download className="size-3.5" />
            </button>
          </div>
          <div
            className="assistant-mermaid-canvas"
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </>
      ) : state.status === "error" ? (
        <div className="assistant-mermaid-error">
          <div className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" />
            Mermaid render failed
          </div>
          <pre>{source}</pre>
          <p>{state.error}</p>
        </div>
      ) : (
        <div className="assistant-mermaid-loading">
          <Spinner />
          <span>Rendering diagram...</span>
        </div>
      )}
    </figure>
  )
}

function useMermaidTheme(): "default" | "dark" {
  const [theme, setTheme] = useState<"default" | "dark">(() => resolveMermaidTheme())

  useEffect(() => {
    const update = (): void => setTheme(resolveMermaidTheme())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return theme
}

function resolveMermaidTheme(): "default" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "default"
}

function hashString(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}
