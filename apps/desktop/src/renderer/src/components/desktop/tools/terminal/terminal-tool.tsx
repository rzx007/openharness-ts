import "@xterm/xterm/css/xterm.css"

import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal as XTermTerminal } from "@xterm/xterm"
import { Eraser, Folder, LoaderCircle, Plus, RotateCcw, SquareTerminal, X } from "lucide-react"
import type * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import type { DesktopTerminalEvent, DesktopTerminalRecord } from "@shared/terminal-types"

import { getXtermTheme } from "./xterm-theme"

type TerminalDataEvent = Extract<DesktopTerminalEvent, { type: "data" }>

type PendingAttach = {
  terminalId: string
  events: TerminalDataEvent[]
}

export function TerminalTool({
  active,
  openRequest,
}: {
  active: boolean
  openRequest: { id: number; terminalId: string } | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const activeTerminalIdRef = useRef<string | null>(null)
  const activeRecordRef = useRef<DesktopTerminalRecord | null>(null)
  const recordsRef = useRef<DesktopTerminalRecord[]>([])
  const selectedProjectIdRef = useRef<string | null>(null)
  const pendingAttachRef = useRef<PendingAttach | null>(null)
  const renderedSequenceRef = useRef(new Map<string, number>())
  const attachGenerationRef = useRef(0)
  const creatingRef = useRef(false)
  const resizeFrameRef = useRef<number | null>(null)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })

  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const rebindProject = useDesktopSessionStore((state) => state.rebindProject)
  const [records, setRecords] = useState<DesktopTerminalRecord[]>([])
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [terminalReady, setTerminalReady] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const projectRecords = useMemo(
    () => records.filter((record) => record.projectId === selectedProject?.id),
    [records, selectedProject?.id]
  )
  const activeRecord = useMemo(
    () =>
      records.find(
        (record) => record.id === activeTerminalId && record.projectId === selectedProject?.id
      ) ?? null,
    [activeTerminalId, records, selectedProject?.id]
  )

  useEffect(() => {
    recordsRef.current = records
  }, [records])

  useEffect(() => {
    selectedProjectIdRef.current = selectedProject?.id ?? null
  }, [selectedProject?.id])

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId
    activeRecordRef.current = activeRecord
  }, [activeRecord, activeTerminalId])

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return

    try {
      fitAddon.fit()
      const nextSize = { cols: terminal.cols, rows: terminal.rows }
      const previous = lastSizeRef.current
      if (nextSize.cols === previous.cols && nextSize.rows === previous.rows) return
      lastSizeRef.current = nextSize

      const record = activeRecordRef.current
      if (record?.status === "running") {
        void window.desktop.terminal.resize({ terminalId: record.id, ...nextSize })
      }
    } catch {
      // xterm can throw while its container is display:none during panel transitions.
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new XTermTerminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "Cascadia Mono, CaskaydiaCove Nerd Font, Consolas, Microsoft YaHei UI, monospace",
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.22,
      scrollback: 5_000,
      theme: getXtermTheme(),
      windowsMode: window.navigator.userAgent.includes("Windows"),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(container)
    terminal.onData((data) => {
      const record = activeRecordRef.current
      if (record?.status === "running") {
        void window.desktop.terminal.write({ terminalId: record.id, data })
      }
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    setTerminalReady(true)
    fitAndResize()

    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = window.requestAnimationFrame(fitAndResize)
    })
    observer.observe(container)

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = getXtermTheme()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    return () => {
      observer.disconnect()
      themeObserver.disconnect()
      if (resizeFrameRef.current) window.cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
      attachGenerationRef.current += 1
      pendingAttachRef.current = null
      setTerminalReady(false)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fitAndResize])

  const createTerminal = useCallback(
    async (preferredName?: string, knownRecords?: DesktopTerminalRecord[]): Promise<void> => {
      const project = selectedProject
      const terminal = terminalRef.current
      if (!project?.available || !terminal || creatingRef.current) return

      creatingRef.current = true
      setCreating(true)
      setError(null)
      fitAndResize()

      const currentRecords = knownRecords ?? recordsRef.current
      const name = preferredName ?? nextTerminalName(currentRecords, project.id)

      try {
        const nextRecord = await window.desktop.terminal.create({
          projectId: project.id,
          runtime: "local",
          name,
          cols: terminal.cols || 80,
          rows: terminal.rows || 24,
        })
        setRecords((current) => [
          ...current.filter((record) => record.id !== nextRecord.id),
          nextRecord,
        ])
        if (selectedProjectIdRef.current === project.id) setActiveTerminalId(nextRecord.id)
      } catch (caught) {
        setError(errorMessage(caught))
      } finally {
        creatingRef.current = false
        setCreating(false)
      }
    },
    [fitAndResize, selectedProject]
  )

  useEffect(() => {
    if (!terminalReady || !active) return
    if (!selectedProject?.available) return

    let cancelled = false
    void window.desktop.terminal
      .list()
      .then((nextRecords) => {
        if (cancelled) return
        setRecords(nextRecords)
        const currentProjectRecords = nextRecords.filter(
          (record) => record.projectId === selectedProject.id
        )
        const currentActive = currentProjectRecords.find(
          (record) => record.id === activeTerminalIdRef.current
        )
        if (currentActive) {
          setActiveTerminalId(currentActive.id)
          return
        }
        const firstRunning = currentProjectRecords.find((record) => record.status === "running")
        const firstRecord = firstRunning ?? currentProjectRecords[0]
        if (firstRecord) {
          setActiveTerminalId(firstRecord.id)
          return
        }
        void createTerminal(undefined, nextRecords)
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught))
      })

    return () => {
      cancelled = true
    }
  }, [active, createTerminal, selectedProject?.available, selectedProject?.id, terminalReady])

  useEffect(() => {
    if (!openRequest || !terminalReady) return
    let cancelled = false
    void window.desktop.terminal
      .list()
      .then((nextRecords) => {
        if (cancelled) return
        const requested = nextRecords.find((record) => record.id === openRequest.terminalId)
        if (!requested) throw new Error("Terminal is no longer available.")
        setRecords(nextRecords)
        setActiveTerminalId(requested.id)
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [openRequest, terminalReady])

  useEffect(() => {
    if (!terminalReady) return
    const terminal = terminalRef.current
    if (!terminal) return

    const generation = ++attachGenerationRef.current
    pendingAttachRef.current = null
    terminal.reset()

    if (!activeTerminalId) return

    const pending: PendingAttach = { terminalId: activeTerminalId, events: [] }
    pendingAttachRef.current = pending

    void window.desktop.terminal
      .read({ terminalId: activeTerminalId })
      .then((snapshot) => {
        if (generation !== attachGenerationRef.current) return
        terminal.reset()
        if (snapshot.truncated) {
          terminal.writeln("\x1b[2m[Earlier terminal output was trimmed]\x1b[0m")
        }
        terminal.write(snapshot.data)
        let renderedSequence = snapshot.sequence
        for (const event of pending.events) {
          if (event.sequence <= renderedSequence) continue
          terminal.write(event.data)
          renderedSequence = event.sequence
        }
        renderedSequenceRef.current.set(activeTerminalId, renderedSequence)
        pendingAttachRef.current = null
        fitAndResize()
        if (active) terminal.focus()
      })
      .catch((caught) => {
        if (generation !== attachGenerationRef.current) return
        pendingAttachRef.current = null
        const message = errorMessage(caught)
        setError(message)
        terminal.writeln(`\r\nTerminal attach failed: ${message}`)
      })
  }, [active, activeTerminalId, fitAndResize, terminalReady])

  useEffect(() => {
    return window.desktop.terminal.onEvent((event) => {
      if (event.type === "data") {
        if (event.terminalId !== activeTerminalIdRef.current) return
        const renderedSequence = renderedSequenceRef.current.get(event.terminalId) ?? 0
        if (event.sequence <= renderedSequence) return
        const pending = pendingAttachRef.current
        if (pending?.terminalId === event.terminalId) {
          pending.events.push(event)
        } else {
          terminalRef.current?.write(event.data)
          renderedSequenceRef.current.set(event.terminalId, event.sequence)
        }
        return
      }

      if (event.type === "exit") {
        setRecords((current) =>
          current.map((record) =>
            record.id === event.terminalId
              ? {
                  ...record,
                  status: "exited",
                  exitedAt: new Date().toISOString(),
                  exitCode: event.exitCode,
                }
              : record
          )
        )
        if (event.terminalId === activeTerminalIdRef.current) {
          terminalRef.current?.writeln(
            `\r\n\x1b[2m[Process exited with code ${event.exitCode ?? "unknown"}]\x1b[0m`
          )
        }
        return
      }

      if (event.type === "error" && event.terminalId === activeTerminalIdRef.current) {
        setError(event.message)
        terminalRef.current?.writeln(`\r\n${event.message}`)
      }
    })
  }, [])

  useEffect(() => {
    if (!active) return
    fitAndResize()
    terminalRef.current?.focus()
  }, [active, fitAndResize])

  const closeTerminal = async (terminalId: string): Promise<void> => {
    renderedSequenceRef.current.delete(terminalId)
    const currentProjectRecords = recordsRef.current.filter(
      (record) => record.projectId === selectedProjectIdRef.current
    )
    const closingIndex = currentProjectRecords.findIndex((record) => record.id === terminalId)
    const remaining = recordsRef.current.filter((record) => record.id !== terminalId)

    if (activeTerminalIdRef.current === terminalId) {
      const remainingProjectRecords = remaining.filter(
        (record) => record.projectId === selectedProjectIdRef.current
      )
      const nextActive =
        remainingProjectRecords[Math.min(closingIndex, remainingProjectRecords.length - 1)] ?? null
      setActiveTerminalId(nextActive?.id ?? null)
    }

    setRecords(remaining)
    try {
      await window.desktop.terminal.kill(terminalId)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const restartTerminal = async (): Promise<void> => {
    const record = activeRecordRef.current
    if (!record) return
    renderedSequenceRef.current.delete(record.id)
    const remaining = recordsRef.current.filter((item) => item.id !== record.id)
    setActiveTerminalId(null)
    setRecords(remaining)

    try {
      await window.desktop.terminal.kill(record.id)
      await createTerminal(record.name, remaining)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const clearTerminal = (): void => {
    const record = activeRecordRef.current
    terminalRef.current?.clear()
    if (record?.status === "running") {
      void window.desktop.terminal.write({ terminalId: record.id, data: "\x0c" })
    }
  }

  return (
    <section
      aria-hidden={!active}
      className={cn(
        "absolute inset-0 flex h-full min-h-0 flex-col bg-panel transition-opacity duration-100",
        !active && "pointer-events-none opacity-0"
      )}
    >
      <div className="flex h-10 shrink-0 items-center border-b px-2 text-[12px] text-ui-muted">
        <div className="terminal-session-strip flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {projectRecords.map((record) => (
            <TerminalSessionTab
              key={record.id}
              record={record}
              active={record.id === activeTerminalId}
              onSelect={() => setActiveTerminalId(record.id)}
              onClose={() => void closeTerminal(record.id)}
            />
          ))}
          <IconButton
            label="新建终端"
            onClick={() => void createTerminal()}
            disabled={creating || !selectedProject?.available}
          >
            {creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
          </IconButton>
        </div>

        {activeRecord && (
          <span
            className="ml-2 max-w-28 shrink-0 truncate rounded-md bg-code px-1.5 py-0.5 font-sans"
            title={`${activeRecord.shell} · ${activeRecord.cwd}`}
          >
            {activeRecord.status === "running" ? shellName(activeRecord.shell) : "exited"}
          </span>
        )}
        <IconButton label="清空终端" onClick={clearTerminal} disabled={!activeRecord}>
          <Eraser />
        </IconButton>
        <IconButton
          label="重启终端"
          onClick={() => void restartTerminal()}
          disabled={!activeRecord}
        >
          <RotateCcw />
        </IconButton>
      </div>

      <div className="relative min-h-0 flex-1 bg-background/55">
        <div ref={containerRef} className="desktop-terminal h-full min-h-0 w-full p-2" />

        {(!selectedProject || !selectedProject.available) && (
          <div className="absolute inset-0 grid place-items-center bg-panel/90 px-8 text-center backdrop-blur-sm">
            <div className="max-w-sm">
              <Folder className="mx-auto mb-3 size-9 text-ui-muted" strokeWidth={1.6} />
              <h2 className="text-[15px] font-semibold text-ui-foreground">
                {selectedProject ? "项目目录不可用" : "未选择项目"}
              </h2>
              <p className="mt-2 text-[13px] leading-6 text-ui-muted">
                {selectedProject
                  ? "当前项目目录可能已被移动，请重新绑定目录后再启动终端。"
                  : "选择项目后，终端会在项目目录中启动。"}
              </p>
              {selectedProject && (
                <button
                  type="button"
                  onClick={() => void rebindProject(selectedProject.id)}
                  className="mt-4 inline-flex h-8 items-center rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  重新绑定目录
                </button>
              )}
            </div>
          </div>
        )}

        {selectedProject?.available && !activeRecord && !creating && (
          <div className="absolute inset-0 grid place-items-center bg-panel/84 px-8 text-center backdrop-blur-sm">
            <div>
              <SquareTerminal className="mx-auto mb-3 size-9 text-ui-muted" strokeWidth={1.6} />
              <p className="text-[13px] text-ui-muted">当前项目没有打开的终端</p>
              <button
                type="button"
                onClick={() => void createTerminal()}
                className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Plus className="size-3.5" />
                新建终端
              </button>
            </div>
          </div>
        )}

        {error && selectedProject?.available && (
          <div className="absolute right-3 bottom-3 max-w-[calc(100%-1.5rem)] rounded-lg border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-lg">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-3 font-medium text-ui-foreground hover:underline"
            >
              关闭
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function TerminalSessionTab({
  record,
  active,
  onSelect,
  onClose,
}: {
  record: DesktopTerminalRecord
  active: boolean
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "group flex h-7 max-w-36 shrink-0 items-center rounded-md transition-colors",
        active
          ? "bg-muted text-ui-foreground"
          : "text-ui-muted hover:bg-muted/55 hover:text-ui-foreground"
      )}
    >
      <button
        type="button"
        title={`${record.name} · ${record.cwd}`}
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            record.status === "running" ? "bg-emerald-500" : "bg-ui-muted/55"
          )}
        />
        <span className="min-w-0 truncate">{record.name}</span>
      </button>
      <button
        type="button"
        title="关闭终端"
        aria-label={`关闭 ${record.name}`}
        onClick={onClose}
        className={cn(
          "mr-1 grid size-5 shrink-0 place-items-center rounded text-ui-muted transition-opacity hover:bg-background/70 hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          active ? "opacity-70" : "opacity-0 group-hover:opacity-70"
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-muted hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

function nextTerminalName(records: DesktopTerminalRecord[], projectId: string): string {
  const used = new Set(
    records
      .filter((record) => record.projectId === projectId)
      .map((record) => /^Terminal (\d+)$/.exec(record.name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
  )
  let index = 1
  while (used.has(index)) index += 1
  return `Terminal ${index}`
}

function shellName(shell: string): string {
  return (
    shell
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.exe$/i, "") || shell
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  return String(error)
}
