import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
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
import { moveUtilityPanelRuntimeState } from "./utility-panel-runtime-state"
import {
  defaultUtilityPanelViewState,
  readPersistedUtilityPanelStates,
  shouldMoveDraftPanelToSession,
  utilityPanelScopeId,
  writePersistedUtilityPanelStates,
  type UtilityPanelViewState,
} from "./utility-panel-state"
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
const collapsedWorkspaceLayout: Layout = { conversation: 100, utility: 0 }

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
  const selectedProjectId = useDesktopSessionStore((state) => state.selectedProject?.id ?? null)
  const panelScopeId = utilityPanelScopeId(activeSessionId, selectedProjectId)
  const [initialPanelStates] = useState(readPersistedUtilityPanelStates)
  const initialPanelState = initialPanelStates[panelScopeId] ?? defaultUtilityPanelViewState()
  const panelStatesRef = useRef(initialPanelStates)
  const activePanelScopeRef = useRef(panelScopeId)
  const previousActiveSessionIdRef = useRef(activeSessionId)
  const knownSessionIdsRef = useRef(new Set(sessions.map((session) => session.id)))
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panelInstanceRevision, setPanelInstanceRevision] = useState(0)
  const [panelStateScopeId, setPanelStateScopeId] = useState(panelScopeId)
  const [panelOpen, setPanelOpen] = useState(initialPanelState.open)
  const [utilityMaximized, setUtilityMaximized] = useState(initialPanelState.maximized)
  const [panelLayout, setPanelLayout] = useState<Layout | null>(initialPanelState.layout)
  const [fileOpenRequest, setFileOpenRequest] = useState<{
    id: number
    scopeId: string
    path: string
    line?: number
  } | null>(null)
  const [terminalOpenRequest, setTerminalOpenRequest] = useState<{
    id: number
    scopeId: string
    terminalId: string
  } | null>(null)
  const [toolOpenRequest, setToolOpenRequest] = useState<{
    id: number
    scopeId: string
    tool: UtilityToolRequest
  } | null>(null)
  const sidebarPanelRef = usePanelRef()
  const conversationPanelRef = usePanelRef()
  const utilityPanelRef = usePanelRef()
  const workspaceGroupRef = useGroupRef()
  const previousWorkspaceLayoutRef = useRef<Layout | null>(null)
  const lastOpenWorkspaceLayoutRef = useRef<Layout | null>(initialPanelState.layout)
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
  const visiblePanelLayout = panelLayout ?? workspaceDefaultLayout
  if (lastOpenWorkspaceLayoutRef.current === null) {
    lastOpenWorkspaceLayoutRef.current = workspaceDefaultLayout
  }

  const persistActivePanelState = useCallback((patch: Partial<UtilityPanelViewState>): void => {
    const scopeId = activePanelScopeRef.current
    const current = panelStatesRef.current[scopeId] ?? defaultUtilityPanelViewState()
    const next = { ...current, ...patch }
    panelStatesRef.current = { ...panelStatesRef.current, [scopeId]: next }
    writePersistedUtilityPanelStates(panelStatesRef.current)
  }, [])

  useEffect(() => {
    if (panelStateScopeId !== activePanelScopeRef.current) return
    persistActivePanelState({
      open: panelOpen,
      maximized: panelOpen && utilityMaximized,
    })
  }, [panelOpen, panelStateScopeId, persistActivePanelState, utilityMaximized])

  useLayoutEffect(() => {
    if (activePanelScopeRef.current === panelScopeId) return

    const previousScopeId = activePanelScopeRef.current
    const createdSessionFromDraft = shouldMoveDraftPanelToSession(
      previousActiveSessionIdRef.current,
      activeSessionId,
      knownSessionIdsRef.current
    )
    if (createdSessionFromDraft) {
      const draftState = panelStatesRef.current[previousScopeId] ?? defaultUtilityPanelViewState()
      const nextStates = { ...panelStatesRef.current, [panelScopeId]: draftState }
      delete nextStates[previousScopeId]
      panelStatesRef.current = nextStates
      writePersistedUtilityPanelStates(nextStates)
      moveUtilityPanelRuntimeState(previousScopeId, panelScopeId)
      setPanelInstanceRevision((current) => current + 1)
    }

    activePanelScopeRef.current = panelScopeId
    const nextState = panelStatesRef.current[panelScopeId] ?? defaultUtilityPanelViewState()
    const nextLayout = nextState.layout ?? workspaceDefaultLayout
    lastOpenWorkspaceLayoutRef.current = nextLayout
    previousWorkspaceLayoutRef.current = null
    setPanelStateScopeId(panelScopeId)
    setPanelLayout(nextLayout)
    setPanelOpen(nextState.open)
    setUtilityMaximized(nextState.maximized)

    const frame = window.requestAnimationFrame(() => {
      const group = workspaceGroupRef.current
      if (nextState.maximized) {
        utilityPanelRef.current?.expand()
        conversationPanelRef.current?.collapse()
        group?.setLayout({ conversation: 0, utility: 100 })
        return
      }

      conversationPanelRef.current?.expand()
      if (nextState.open) {
        utilityPanelRef.current?.expand()
        group?.setLayout(nextLayout)
      } else {
        utilityPanelRef.current?.collapse()
        group?.setLayout(collapsedWorkspaceLayout)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    activeSessionId,
    conversationPanelRef,
    panelScopeId,
    utilityPanelRef,
    workspaceDefaultLayout,
    workspaceGroupRef,
  ])

  useEffect(() => {
    previousActiveSessionIdRef.current = activeSessionId
    knownSessionIdsRef.current = new Set(sessions.map((session) => session.id))
  }, [activeSessionId, sessions])

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
    persistActivePanelState({ open: true })
    setPanelOpen(true)
  }, [persistActivePanelState, sidebarPanelRef, utilityPanelRef, workspaceGroupRef])

  const collapseUtilityPanel = useCallback((): void => {
    const currentLayout = workspaceGroupRef.current?.getLayout()
    if (isOpenWorkspaceLayout(currentLayout)) {
      lastOpenWorkspaceLayoutRef.current = currentLayout
      setPanelLayout(currentLayout)
      persistActivePanelState({ layout: currentLayout })
    }
    previousWorkspaceLayoutRef.current = null
    persistActivePanelState({ open: false, maximized: false })
    setUtilityMaximized(false)
    setPanelOpen(false)
    utilityPanelRef.current?.collapse()
  }, [persistActivePanelState, utilityPanelRef, workspaceGroupRef])

  const togglePanel = useCallback((): void => {
    const panel = utilityPanelRef.current
    if (!panel) {
      const nextOpen = !panelOpen
      persistActivePanelState({ open: nextOpen, maximized: false })
      setPanelOpen(nextOpen)
      return
    }

    if (panel.isCollapsed()) restoreUtilityPanel()
    else collapseUtilityPanel()
  }, [
    collapseUtilityPanel,
    panelOpen,
    persistActivePanelState,
    restoreUtilityPanel,
    utilityPanelRef,
  ])

  const openWorkspaceFile = useCallback(
    (path: string, line?: number): void => {
      restoreUtilityPanel()
      setFileOpenRequest({ id: Date.now(), scopeId: activePanelScopeRef.current, path, line })
    },
    [restoreUtilityPanel]
  )

  const openTerminal = useCallback(
    (terminalId: string): void => {
      restoreUtilityPanel()
      setTerminalOpenRequest({
        id: Date.now(),
        scopeId: activePanelScopeRef.current,
        terminalId,
      })
    },
    [restoreUtilityPanel]
  )

  const openUtilityTool = useCallback(
    (tool: UtilityToolRequest): void => {
      restoreUtilityPanel()
      setToolOpenRequest({ id: Date.now(), scopeId: activePanelScopeRef.current, tool })
    },
    [restoreUtilityPanel]
  )

  const closeUtilityPanel = useCallback((): void => {
    collapseUtilityPanel()
  }, [collapseUtilityPanel])

  const toggleUtilityMaximized = useCallback((): void => {
    if (utilityMaximized) {
      conversationPanelRef.current?.expand()
      persistActivePanelState({ maximized: false })
      setUtilityMaximized(false)
      return
    }

    const currentLayout = workspaceGroupRef.current?.getLayout()
    if (currentLayout?.conversation && currentLayout.utility) {
      previousWorkspaceLayoutRef.current = currentLayout
    }
    if (utilityPanelRef.current?.isCollapsed()) utilityPanelRef.current.expand()
    conversationPanelRef.current?.collapse()
    persistActivePanelState({ open: true, maximized: true })
    setPanelOpen(true)
    setUtilityMaximized(true)
  }, [
    conversationPanelRef,
    persistActivePanelState,
    utilityMaximized,
    utilityPanelRef,
    workspaceGroupRef,
  ])

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
      setPanelLayout(layout)
      persistActivePanelState({ layout })
      workspaceLayout.onLayoutChanged(layout, meta)
    },
    [persistActivePanelState, utilityMaximized, workspaceLayout]
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
      defaultLayout={
        utilityMaximized
          ? { conversation: 0, utility: 100 }
          : panelOpen
            ? visiblePanelLayout
            : collapsedWorkspaceLayout
      }
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
        defaultSize={panelOpen ? `${visiblePanelLayout.utility ?? 60}%` : 0}
        minSize={panelOpen || utilityMaximized ? utilityMinimumWidth : 0}
        maxSize={utilityMaximized ? "100%" : "70%"}
        collapsedSize={0}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        className="h-full min-h-0 overflow-hidden"
        onResize={(size) => {
          const nextOpen = size.inPixels > 1
          if (panelOpen !== nextOpen) setPanelOpen(nextOpen)
        }}
      >
        <UtilityPanel
          key={`${panelScopeId}:${panelInstanceRevision}`}
          scopeId={panelScopeId}
          open={panelOpen}
          maximized={utilityMaximized}
          onToggleMaximized={toggleUtilityMaximized}
          onClose={closeUtilityPanel}
          fileOpenRequest={fileOpenRequest?.scopeId === panelScopeId ? fileOpenRequest : null}
          terminalOpenRequest={
            terminalOpenRequest?.scopeId === panelScopeId ? terminalOpenRequest : null
          }
          toolOpenRequest={toolOpenRequest?.scopeId === panelScopeId ? toolOpenRequest : null}
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
