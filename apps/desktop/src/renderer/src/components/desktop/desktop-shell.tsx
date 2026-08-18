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
import { ScheduledPage } from "@renderer/components/desktop/scheduled-page"
import { Sidebar } from "@renderer/components/desktop/sidebar"
import { SettingsContent, SettingsSidebar } from "@renderer/components/desktop/settings-page"
import { TitleBar, type UtilityToolRequest } from "@renderer/components/desktop/title-bar"
import { useDesktopShortcuts } from "@renderer/components/desktop/use-desktop-shortcuts"
import { UtilityPanel } from "@renderer/components/desktop/utility-panel"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import {
  createSessionNavigationState,
  currentSessionDestination,
  moveSessionNavigation,
  recordSessionDestination,
} from "@renderer/components/desktop/session-navigation"
import {
  attachDesktopSessionEvents,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session-store"
import { actualSizeZoomLevel, normalizeZoomLevel } from "@shared/zoom"

const resizeTargetMinimumSize = { fine: 12, coarse: 28 }
const sidebarDefaultWidth = 288
const sidebarMinimumWidth = 236
const conversationMinimumWidth = 350
const utilityMinimumWidth = 320
const workspaceMinimumWidth = conversationMinimumWidth + utilityMinimumWidth
const defaultWorkspaceLayout: Layout = { conversation: 40, utility: 60 }

function isOpenWorkspaceLayout(layout: Layout | null | undefined): layout is Layout {
  return Number(layout?.conversation) > 5 && Number(layout?.utility) > 5
}

export function DesktopShell(): React.JSX.Element {
  const initializeSessions = useDesktopSessionStore((state) => state.initialize)
  const startNewConversation = useDesktopSessionStore((state) => state.startNewConversation)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const openSession = useDesktopSessionStore((state) => state.openSession)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState("常规")
  const [primaryView, setPrimaryView] = useState<"conversation" | "scheduled">("conversation")
  const [panelOpen, setPanelOpen] = useState(true)
  const [utilityMaximized, setUtilityMaximized] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(actualSizeZoomLevel)
  const [navigationReady, setNavigationReady] = useState(false)
  const [navigation, setNavigation] = useState(() => createSessionNavigationState(null))
  const [fileOpenRequest, setFileOpenRequest] = useState<{
    id: number
    path: string
    line?: number
  } | null>(null)
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    id: number
    terminalId: string
  } | null>(null)
  const [toolOpenRequest, setToolOpenRequest] = useState<{
    id: number
    tool: UtilityToolRequest
  } | null>(null)
  const sidebarPanelRef = usePanelRef()
  const conversationPanelRef = usePanelRef()
  const utilityPanelRef = usePanelRef()
  const workspaceGroupRef = useGroupRef()
  const previousWorkspaceLayoutRef = useRef<Layout | null>(null)
  const lastOpenWorkspaceLayoutRef = useRef<Layout | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const zoomLevelRef = useRef(actualSizeZoomLevel)
  const initializationRef = useRef<Promise<void> | null>(null)
  const navigationTargetRef = useRef<{ destination: string | null } | null>(null)
  const outerLayout = useDefaultLayout({
    id: "desktop-shell-layout-v1",
    panelIds: ["sidebar", "workspace"],
  })
  const workspaceLayout = useDefaultLayout({
    id: "desktop-workspace-layout-v3",
    panelIds: ["conversation", "utility"],
  })
  const workspaceDefaultLayout = isOpenWorkspaceLayout(workspaceLayout.defaultLayout)
    ? workspaceLayout.defaultLayout
    : defaultWorkspaceLayout
  if (lastOpenWorkspaceLayoutRef.current === null) {
    lastOpenWorkspaceLayoutRef.current = workspaceDefaultLayout
  }

  useEffect(() => {
    void window.desktop.window.isMaximized().then(setIsMaximized)
    void window.desktop.window.getZoomLevel().then((level) => {
      const normalizedLevel = normalizeZoomLevel(level)
      zoomLevelRef.current = normalizedLevel
      setZoomLevel(normalizedLevel)
    })
    return window.desktop.window.onMaximizedChanged(setIsMaximized)
  }, [])

  useEffect(() => {
    const detach = attachDesktopSessionEvents()
    let disposed = false
    const initialization = initializationRef.current ?? initializeSessions()
    initializationRef.current = initialization
    void initialization.finally(() => {
      if (disposed) return
      const destination = useDesktopSessionStore.getState().activeSessionId
      setNavigation(createSessionNavigationState(destination))
      setNavigationReady(true)
    })
    return () => {
      disposed = true
      detach()
    }
  }, [initializeSessions])

  useEffect(() => {
    if (!navigationReady) return
    const expected = navigationTargetRef.current
    if (expected && expected.destination === activeSessionId) {
      navigationTargetRef.current = null
      return
    }
    setNavigation((current) => recordSessionDestination(current, activeSessionId))
  }, [activeSessionId, navigationReady])

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

  const restoreUtilityPanel = useCallback((): void => {
    if (window.innerWidth < 1180) sidebarPanelRef.current?.collapse()
    const group = workspaceGroupRef.current
    const panel = utilityPanelRef.current
    const layout = lastOpenWorkspaceLayoutRef.current ?? defaultWorkspaceLayout
    if (panel?.isCollapsed()) {
      panel.expand()
      window.requestAnimationFrame(() => {
        group?.setLayout(layout)
      })
    }
    setPanelOpen(true)
  }, [sidebarPanelRef, utilityPanelRef, workspaceGroupRef])

  const collapseUtilityPanel = useCallback((): void => {
    const currentLayout = workspaceGroupRef.current?.getLayout()
    if (isOpenWorkspaceLayout(currentLayout)) {
      lastOpenWorkspaceLayoutRef.current = currentLayout
    }
    previousWorkspaceLayoutRef.current = null
    setUtilityMaximized(false)
    utilityPanelRef.current?.collapse()
  }, [utilityPanelRef, workspaceGroupRef])

  const togglePanel = useCallback((): void => {
    const panel = utilityPanelRef.current
    if (!panel) {
      setPanelOpen((current) => !current)
      return
    }

    if (panel.isCollapsed()) restoreUtilityPanel()
    else collapseUtilityPanel()
  }, [collapseUtilityPanel, restoreUtilityPanel, utilityPanelRef])

  const openWorkspaceFile = useCallback(
    (path: string, line?: number): void => {
      restoreUtilityPanel()
      setFileOpenRequest({ id: Date.now(), path, line })
    },
    [restoreUtilityPanel]
  )

  const openTerminal = useCallback(
    (terminalId: string): void => {
      restoreUtilityPanel()
      setTerminalOpenRequest({ id: Date.now(), terminalId })
    },
    [restoreUtilityPanel]
  )

  const openUtilityTool = useCallback(
    (tool: UtilityToolRequest): void => {
      restoreUtilityPanel()
      setToolOpenRequest({ id: Date.now(), tool })
    },
    [restoreUtilityPanel]
  )

  const closeUtilityPanel = useCallback((): void => {
    collapseUtilityPanel()
  }, [collapseUtilityPanel])

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

  const restoreSessionDestination = useCallback(
    (destination: string | null): void => {
      setPrimaryView("conversation")
      navigationTargetRef.current = { destination }
      if (destination) void openSession(destination)
      else void startNewConversation()
    },
    [openSession, startNewConversation]
  )

  const moveNavigation = useCallback(
    (offset: -1 | 1): void => {
      const next = moveSessionNavigation(navigation, offset)
      if (next === navigation) return
      setNavigation(next)
      restoreSessionDestination(currentSessionDestination(next))
    },
    [navigation, restoreSessionDestination]
  )

  const activeSessionIndex = sessions.findIndex((session) => session.id === activeSessionId)
  const previousSession = activeSessionIndex > 0 ? sessions[activeSessionIndex - 1] : null
  const nextSession =
    activeSessionIndex >= 0 && activeSessionIndex < sessions.length - 1
      ? sessions[activeSessionIndex + 1]
      : null

  const openPreviousSession = useCallback((): void => {
    if (previousSession) {
      setPrimaryView("conversation")
      void openSession(previousSession.id)
    }
  }, [openSession, previousSession])

  const openNextSession = useCallback((): void => {
    if (nextSession) {
      setPrimaryView("conversation")
      void openSession(nextSession.id)
    }
  }, [nextSession, openSession])

  const applyZoomLevel = useCallback((requestedLevel: number): void => {
    const nextLevel = normalizeZoomLevel(requestedLevel)
    zoomLevelRef.current = nextLevel
    setZoomLevel(nextLevel)
    void window.desktop.window.setZoomLevel(nextLevel).then((appliedLevel) => {
      const normalizedLevel = normalizeZoomLevel(appliedLevel)
      zoomLevelRef.current = normalizedLevel
      setZoomLevel(normalizedLevel)
    })
  }, [])

  const zoomIn = useCallback((): void => {
    applyZoomLevel(zoomLevelRef.current + 1)
  }, [applyZoomLevel])

  const zoomOut = useCallback((): void => {
    applyZoomLevel(zoomLevelRef.current - 1)
  }, [applyZoomLevel])

  const resetZoom = useCallback((): void => {
    applyZoomLevel(actualSizeZoomLevel)
  }, [applyZoomLevel])

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
      if (utilityMaximized || !isOpenWorkspaceLayout(layout)) return
      lastOpenWorkspaceLayoutRef.current = layout
      workspaceLayout.onLayoutChanged(layout, meta)
    },
    [utilityMaximized, workspaceLayout]
  )

  useDesktopShortcuts({
    newConversation: () => {
      setPrimaryView("conversation")
      void startNewConversation()
    },
    chooseProject: () => {
      setPrimaryView("conversation")
      void chooseProject()
    },
    closeConversation: () => {
      if (activeSessionId) {
        setPrimaryView("conversation")
        void startNewConversation()
      }
    },
    quit: () => void window.desktop.app.quit(),
    toggleSidebar,
    togglePanel,
    openBrowser: () => openUtilityTool("browser"),
    openFiles: () => openUtilityTool("files"),
    openTerminal: () => openUtilityTool("terminal"),
    previousSession: openPreviousSession,
    nextSession: openNextSession,
    goBack: () => moveNavigation(-1),
    goForward: () => moveNavigation(1),
    zoomIn,
    zoomOut,
    resetZoom,
  })

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground">
      <TitleBar
        sidebarOpen={sidebarOpen}
        panelOpen={panelOpen}
        isMaximized={isMaximized}
        hasActiveSession={Boolean(activeSessionId)}
        canGoBack={navigation.index > 0}
        canGoForward={navigation.index < navigation.entries.length - 1}
        canOpenPreviousSession={Boolean(previousSession)}
        canOpenNextSession={Boolean(nextSession)}
        zoomLevel={zoomLevel}
        onGoBack={() => moveNavigation(-1)}
        onGoForward={() => moveNavigation(1)}
        onNewConversation={() => {
          setPrimaryView("conversation")
          void startNewConversation()
        }}
        onChooseProject={() => {
          setPrimaryView("conversation")
          void chooseProject()
        }}
        onCloseConversation={() => {
          setPrimaryView("conversation")
          void startNewConversation()
        }}
        onOpenPreviousSession={openPreviousSession}
        onOpenNextSession={openNextSession}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={togglePanel}
        onOpenUtilityTool={openUtilityTool}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
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
            {settingsOpen ? (
              <SettingsSidebar
                selectedSection={settingsSection}
                onSelectSection={setSettingsSection}
                onClose={() => setSettingsOpen(false)}
              />
            ) : (
              <Sidebar
                open={sidebarOpen}
                scheduledSelected={primaryView === "scheduled"}
                onOpenScheduled={() => setPrimaryView("scheduled")}
                onOpenConversation={() => setPrimaryView("conversation")}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
          </Panel>

          <PanelResizeHandle label="调整侧边栏宽度" />

          <Panel
            id="workspace"
            minSize={workspaceMinimumWidth}
            className="h-full min-h-0"
            style={{ overflow: "visible" }}
          >
            <section className="border-workspace flex h-full min-w-0 overflow-hidden rounded-tl-lg border-t border-l bg-conversation shadow-workspace">
              {settingsOpen ? (
                <SettingsContent selectedSection={settingsSection} />
              ) : primaryView === "scheduled" ? (
                <ScheduledPage
                  onStartConversation={() => {
                    setPrimaryView("conversation")
                    void startNewConversation()
                  }}
                />
              ) : (
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
                    minSize={utilityMinimumWidth}
                    maxSize={utilityMaximized ? "100%" : "70%"}
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
                      toolOpenRequest={toolOpenRequest}
                    />
                  </Panel>
                </Group>
              )}
            </section>
          </Panel>
        </Group>
      </div>
    </main>
  )
}
