import { useCallback, useEffect, useRef, useState } from "react"
import { Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router"
import {
  Group,
  Panel,
  type Layout,
  type LayoutChangedMeta,
  useDefaultLayout,
  useGroupRef,
  usePanelRef,
} from "react-resizable-panels"

import { ConversationPane } from "@renderer/components/desktop/conversation-page"
import { defaultSettingsSection } from "@renderer/components/desktop/settings-page/settings-navigation"
import { useDesktopShortcuts } from "@renderer/components/desktop/use-desktop-shortcuts"
import { MainLayoutContext } from "./main-layout-context"
import { Sidebar } from "./sidebar"
import { TitleBar, type UtilityToolRequest } from "./title-bar"
import { UtilityPanel } from "./utility-panel"
import { useDesktopWindowChrome } from "./use-desktop-window-chrome"
import { PanelResizeHandle } from "@renderer/components/ui/panel-resize-handle"
import {
  attachDesktopSessionEvents,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session-store"

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

export function MainLayout(): React.JSX.Element {
  const navigate = useNavigate()
  const router = useRouter()
  const historyIndex = useRouterState({
    select: (state) => state.location.state.__TSR_index,
  })
  const startNewConversation = useDesktopSessionStore((state) => state.startNewConversation)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(true)
  const [utilityMaximized, setUtilityMaximized] = useState(false)
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
  const { isMaximized, zoomLevel, zoomIn, zoomOut, resetZoom, minimize, toggleMaximize, close } =
    useDesktopWindowChrome()
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
    const detach = attachDesktopSessionEvents()
    return detach
  }, [])

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

  const openConversationRoute = useCallback(
    (destination: string | null | undefined): void => {
      const sessionId = destination === undefined ? activeSessionId : destination
      if (sessionId) {
        void navigate({
          to: "/conversation/$sessionId",
          params: { sessionId },
        })
      } else {
        void navigate({ to: "/" })
      }
    },
    [activeSessionId, navigate]
  )

  const startNewConversationRoute = useCallback((): void => {
    void startNewConversation().then(() => navigate({ to: "/" }))
  }, [navigate, startNewConversation])

  const showCurrentConversation = useCallback((): void => {
    openConversationRoute(undefined)
  }, [openConversationRoute])

  const activeSessionIndex = sessions.findIndex((session) => session.id === activeSessionId)
  const previousSession = activeSessionIndex > 0 ? sessions[activeSessionIndex - 1] : null
  const nextSession =
    activeSessionIndex >= 0 && activeSessionIndex < sessions.length - 1
      ? sessions[activeSessionIndex + 1]
      : null

  const openPreviousSession = useCallback((): void => {
    if (previousSession) openConversationRoute(previousSession.id)
  }, [openConversationRoute, previousSession])

  const openNextSession = useCallback((): void => {
    if (nextSession) openConversationRoute(nextSession.id)
  }, [nextSession, openConversationRoute])

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
    newConversation: startNewConversationRoute,
    chooseProject: () => {
      showCurrentConversation()
      void chooseProject()
    },
    closeConversation: () => {
      if (activeSessionId) startNewConversationRoute()
    },
    quit: () => void window.desktop.app.quit(),
    toggleSidebar,
    togglePanel,
    openBrowser: () => openUtilityTool("browser"),
    openFiles: () => openUtilityTool("files"),
    openTerminal: () => openUtilityTool("terminal"),
    previousSession: openPreviousSession,
    nextSession: openNextSession,
    goBack: () => router.history.back(),
    goForward: () => router.history.forward(),
    zoomIn,
    zoomOut,
    resetZoom,
  })

  const renderPage = (sidebar: React.ReactNode): React.JSX.Element => (
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
          {sidebar}
        </Panel>
        <PanelResizeHandle label="调整侧边栏宽度" />
        <Panel
          id="workspace"
          minSize={workspaceMinimumWidth}
          className="h-full min-h-0"
          style={{ overflow: "visible" }}
        >
          <section className="border-workspace flex h-full min-w-0 overflow-hidden rounded-tl-lg border-t border-l bg-conversation shadow-workspace">
            <Outlet />
          </section>
        </Panel>
      </Group>
    </div>
  )

  const renderConversationWorkspace = (): React.JSX.Element => (
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
          onOpenAgents={() => openUtilityTool("agents")}
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
          onOpenFile={openWorkspaceFile}
          onOpenTerminal={openTerminal}
        />
      </Panel>
    </Group>
  )

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground">
      <TitleBar
        sidebarOpen={sidebarOpen}
        panelOpen={panelOpen}
        isMaximized={isMaximized}
        hasActiveSession={Boolean(activeSessionId)}
        canGoBack={router.history.canGoBack()}
        canGoForward={historyIndex < router.history.length - 1}
        canOpenPreviousSession={Boolean(previousSession)}
        canOpenNextSession={Boolean(nextSession)}
        zoomLevel={zoomLevel}
        onGoBack={() => router.history.back()}
        onGoForward={() => router.history.forward()}
        onNewConversation={startNewConversationRoute}
        onChooseProject={() => {
          showCurrentConversation()
          void chooseProject()
        }}
        onCloseConversation={startNewConversationRoute}
        onOpenPreviousSession={openPreviousSession}
        onOpenNextSession={openNextSession}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={togglePanel}
        onOpenUtilityTool={openUtilityTool}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
        onMinimize={minimize}
        onToggleMaximize={toggleMaximize}
        onClose={close}
      />
      <MainLayoutContext.Provider
        value={{
          conversationWorkspace: renderConversationWorkspace(),
          startNewConversation: startNewConversationRoute,
        }}
      >
        {renderPage(
          <Sidebar
            open={sidebarOpen}
            onOpenScheduled={() => void navigate({ to: "/scheduled" })}
            onOpenConversation={openConversationRoute}
            onOpenSettings={() =>
              void navigate({
                to: "/settings/$section",
                params: { section: defaultSettingsSection },
              })
            }
          />
        )}
      </MainLayoutContext.Provider>
    </main>
  )
}
