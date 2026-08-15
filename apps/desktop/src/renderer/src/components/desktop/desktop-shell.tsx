import { useCallback, useEffect, useRef, useState } from "react"
import {
  Group,
  Panel,
  type Layout,
  type LayoutChangedMeta,
  useDefaultLayout,
  useGroupRef,
  usePanelRef,
} from "react-resizable-panels"

import { ConversationPane } from "@renderer/components/desktop/conversation-pane"
import { Sidebar } from "@renderer/components/desktop/sidebar"
import { TitleBar } from "@renderer/components/desktop/title-bar"
import { UtilityPanel } from "@renderer/components/desktop/utility-panel"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import {
  attachDesktopSessionEvents,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session-store"

const resizeTargetMinimumSize = { fine: 12, coarse: 28 }
const sidebarDefaultWidth = 288
const sidebarMinimumWidth = 236
const conversationMinimumWidth = 300
const defaultWorkspaceLayout: Layout = { conversation: 55, utility: 45 }

export function DesktopShell(): React.JSX.Element {
  const initializeSessions = useDesktopSessionStore((state) => state.initialize)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(true)
  const [utilityMaximized, setUtilityMaximized] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [fileOpenRequest, setFileOpenRequest] = useState<{
    id: number
    path: string
    line?: number
  } | null>(null)
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    id: number
    terminalId: string
  } | null>(null)
  const sidebarPanelRef = usePanelRef()
  const conversationPanelRef = usePanelRef()
  const utilityPanelRef = usePanelRef()
  const workspaceGroupRef = useGroupRef()
  const previousWorkspaceLayoutRef = useRef<Layout | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const outerLayout = useDefaultLayout({
    id: "desktop-shell-layout-v1",
    panelIds: ["sidebar", "workspace"],
  })
  const workspaceLayout = useDefaultLayout({
    id: "desktop-workspace-layout-v1",
    panelIds: ["conversation", "utility"],
  })
  const workspaceDefaultLayout = workspaceLayout.defaultLayout ?? defaultWorkspaceLayout

  useEffect(() => {
    void window.desktop.window.isMaximized().then(setIsMaximized)
    return window.desktop.window.onMaximizedChanged(setIsMaximized)
  }, [])

  useEffect(() => {
    const detach = attachDesktopSessionEvents()
    void initializeSessions()
    return detach
  }, [initializeSessions])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const sidebarSize = sidebarPanelRef.current?.getSize()
      if (!sidebarSize) return
      contentRef.current?.style.setProperty("--sidebar-width", `${sidebarSize.inPixels}px`)
      setSidebarOpen((current) => {
        const nextOpen = sidebarSize.inPixels > 1
        return current === nextOpen ? current : nextOpen
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sidebarPanelRef])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const utilitySize = utilityPanelRef.current?.getSize()
      if (!utilitySize) return
      setPanelOpen((current) => {
        const nextOpen = utilitySize.inPixels > 1
        return current === nextOpen ? current : nextOpen
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [utilityPanelRef])

  const toggleSidebar = useCallback((): void => {
    const panel = sidebarPanelRef.current
    if (!panel) {
      setSidebarOpen((current) => !current)
      return
    }

    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [sidebarPanelRef])

  const togglePanel = useCallback((): void => {
    const panel = utilityPanelRef.current
    if (!panel) {
      setPanelOpen((current) => !current)
      return
    }

    if (panel.isCollapsed()) {
      if (window.innerWidth < 1180) sidebarPanelRef.current?.collapse()
      panel.expand()
    } else {
      previousWorkspaceLayoutRef.current = null
      setUtilityMaximized(false)
      panel.collapse()
    }
  }, [sidebarPanelRef, utilityPanelRef])

  const openWorkspaceFile = useCallback(
    (path: string, line?: number): void => {
      if (window.innerWidth < 1180) sidebarPanelRef.current?.collapse()
      utilityPanelRef.current?.expand()
      setPanelOpen(true)
      setFileOpenRequest({ id: Date.now(), path, line })
    },
    [sidebarPanelRef, utilityPanelRef]
  )

  const openTerminal = useCallback(
    (terminalId: string): void => {
      if (window.innerWidth < 1180) sidebarPanelRef.current?.collapse()
      utilityPanelRef.current?.expand()
      setPanelOpen(true)
      setTerminalOpenRequest({ id: Date.now(), terminalId })
    },
    [sidebarPanelRef, utilityPanelRef]
  )

  const closeUtilityPanel = useCallback((): void => {
    previousWorkspaceLayoutRef.current = null
    setUtilityMaximized(false)
    utilityPanelRef.current?.collapse()
  }, [utilityPanelRef])

  const toggleUtilityMaximized = useCallback((): void => {
    if (utilityMaximized) {
      conversationPanelRef.current?.expand()
      setUtilityMaximized(false)
      return
    }

    const currentLayout = workspaceGroupRef.current?.getLayout()
    if (currentLayout?.conversation && currentLayout.utility) {
      previousWorkspaceLayoutRef.current = currentLayout
    }
    if (utilityPanelRef.current?.isCollapsed()) utilityPanelRef.current.expand()
    conversationPanelRef.current?.collapse()
    setPanelOpen(true)
    setUtilityMaximized(true)
  }, [conversationPanelRef, utilityMaximized, utilityPanelRef, workspaceGroupRef])

  useEffect(() => {
    const group = workspaceGroupRef.current
    if (!group) return

    window.requestAnimationFrame(() => {
      if (utilityMaximized) {
        conversationPanelRef.current?.collapse()
        group.setLayout({ conversation: 0, utility: 100 })
        return
      }

      conversationPanelRef.current?.expand()
      const previousLayout = previousWorkspaceLayoutRef.current
      if (previousLayout) {
        group.setLayout(previousLayout)
        previousWorkspaceLayoutRef.current = null
      }
    })
  }, [conversationPanelRef, sidebarOpen, utilityMaximized, workspaceGroupRef])

  const handleWorkspaceLayoutChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta): void => {
      if (!utilityMaximized) workspaceLayout.onLayoutChanged(layout, meta)
    },
    [utilityMaximized, workspaceLayout]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (isEditableTarget(event.target)) return

      if (event.key.toLowerCase() === "b") {
        event.preventDefault()
        toggleSidebar()
      }

      if (event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault()
        togglePanel()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [togglePanel, toggleSidebar])

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground">
      <TitleBar
        sidebarOpen={sidebarOpen}
        isMaximized={isMaximized}
        onToggleSidebar={toggleSidebar}
        onMinimize={() => void window.desktop.window.minimize()}
        onToggleMaximize={() => void window.desktop.window.toggleMaximize()}
        onClose={() => void window.desktop.window.close()}
      />

      <div
        ref={contentRef}
        className="relative min-h-0 flex-1 overflow-visible"
        style={{ "--sidebar-width": `${sidebarDefaultWidth}px` } as React.CSSProperties}
      >
        <div
          aria-hidden="true"
          className="workspace-top-shadow pointer-events-none absolute top-0 right-0 z-20 h-px"
          style={{ left: "calc(var(--sidebar-width) + 1px)" }}
        />

        <Group
          id="desktop-shell"
          orientation="horizontal"
          className="h-full min-h-0"
          resizeTargetMinimumSize={resizeTargetMinimumSize}
          defaultLayout={outerLayout.defaultLayout}
          onLayoutChanged={outerLayout.onLayoutChanged}
        >
          <Panel
            id="sidebar"
            panelRef={sidebarPanelRef}
            defaultSize={sidebarDefaultWidth}
            minSize={sidebarMinimumWidth}
            maxSize={420}
            collapsedSize={0}
            collapsible
            groupResizeBehavior="preserve-pixel-size"
            className="h-full min-h-0 overflow-hidden"
            onResize={(size) => {
              contentRef.current?.style.setProperty("--sidebar-width", `${size.inPixels}px`)
              const nextOpen = size.inPixels > 1
              setSidebarOpen((current) => (current === nextOpen ? current : nextOpen))
            }}
          >
            <Sidebar open={sidebarOpen} />
          </Panel>

          <PanelResizeHandle label="调整侧边栏宽度" />

          <Panel
            id="workspace"
            minSize={560}
            className="h-full min-h-0"
            style={{ overflow: "visible" }}
          >
            <section className="border-workspace flex h-full min-w-0 overflow-hidden rounded-tl-lg border-t border-l bg-conversation shadow-workspace">
              <Group
                id="desktop-workspace"
                groupRef={workspaceGroupRef}
                orientation="horizontal"
                className="h-full min-h-0 w-full"
                resizeTargetMinimumSize={resizeTargetMinimumSize}
                defaultLayout={workspaceDefaultLayout}
                onLayoutChanged={handleWorkspaceLayoutChanged}
              >
                <Panel
                  id="conversation"
                  panelRef={conversationPanelRef}
                  defaultSize="100%"
                  minSize={utilityMaximized ? 0 : conversationMinimumWidth}
                  collapsedSize={0}
                  collapsible
                  className="h-full min-h-0 overflow-hidden"
                >
                  <ConversationPane
                    panelOpen={panelOpen}
                    onTogglePanel={togglePanel}
                    onOpenFile={openWorkspaceFile}
                    onOpenTerminal={openTerminal}
                  />
                </Panel>

                {!utilityMaximized && <PanelResizeHandle label="调整工具面板宽度" />}

                <Panel
                  id="utility"
                  panelRef={utilityPanelRef}
                  defaultSize={`${defaultWorkspaceLayout.utility}%`}
                  minSize={320}
                  maxSize={utilityMaximized ? "100%" : "58%"}
                  collapsedSize={0}
                  collapsible
                  groupResizeBehavior="preserve-pixel-size"
                  className="h-full min-h-0 overflow-hidden"
                  onResize={(size) => {
                    const nextOpen = size.inPixels > 1
                    setPanelOpen((current) => (current === nextOpen ? current : nextOpen))
                  }}
                >
                  <UtilityPanel
                    open={panelOpen}
                    maximized={utilityMaximized}
                    onToggleMaximized={toggleUtilityMaximized}
                    onClose={closeUtilityPanel}
                    fileOpenRequest={fileOpenRequest}
                    terminalOpenRequest={terminalOpenRequest}
                  />
                </Panel>
              </Group>
            </section>
          </Panel>
        </Group>
      </div>
    </main>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']")
  )
}
