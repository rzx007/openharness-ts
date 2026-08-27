import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { DesktopOperation, DesktopSessionState } from "@renderer/stores/desktop-session/types"

const harness = vi.hoisted(() => ({ state: null as unknown as DesktopSessionState }))

vi.mock("@tanstack/react-router", async () => {
  const { useContext } = await import("react")
  const { MainLayoutContext } = await import("./main-layout-context")

  return {
    Outlet: () => useContext(MainLayoutContext)?.conversationWorkspace ?? null,
    useNavigate: () => vi.fn(),
    useMatchRoute: () => () => false,
    useRouter: () => ({
      history: {
        back: vi.fn(),
        forward: vi.fn(),
        canGoBack: () => false,
        canGoForward: () => false,
      },
    }),
    useRouterState: () => 0,
  }
})

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children?: React.ReactNode }) => children,
  Panel: ({ children }: { children?: React.ReactNode }) => children,
  useDefaultLayout: () => ({ defaultLayout: null, onLayoutChanged: vi.fn() }),
  useGroupRef: () => ({ current: null }),
  usePanelRef: () => ({ current: null }),
}))

vi.mock("@renderer/components/desktop/settings-page/settings-navigation", () => ({
  defaultSettingsSection: "general",
}))
vi.mock("@renderer/components/theme-provider", () => ({
  useTheme: () => ({ theme: "light" as const, setTheme: vi.fn() }),
}))
vi.mock("@renderer/components/desktop/use-desktop-shortcuts", () => ({
  useDesktopShortcuts: () => undefined,
}))
vi.mock("@renderer/components/ui/panel-resize-handle", () => ({
  PanelResizeHandle: () => null,
}))
vi.mock("@renderer/components/desktop/layout/title-bar", () => ({ TitleBar: () => null }))
vi.mock("@renderer/components/desktop/layout/use-desktop-window-chrome", () => ({
  useDesktopWindowChrome: () => ({
    isMaximized: false,
    zoomLevel: 1,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}))
vi.mock("@renderer/components/desktop/layout/main-layout/utility-panel", () => ({
  UtilityPanel: () => null,
  useUtilityPanelController: () => ({
    open: false,
    maximized: false,
    visibleLayout: { conversation: 100, utility: 0 },
    toggle: vi.fn(),
    openFile: vi.fn(),
    openReview: vi.fn(),
    openTerminal: vi.fn(),
    openTool: vi.fn(),
    handleLayoutChanged: vi.fn(),
    handlePanelResize: vi.fn(),
    collapse: vi.fn(),
    instanceKey: "test",
    scopeId: "test",
    fileOpenRequest: null,
    reviewOpenRequest: null,
    terminalOpenRequest: null,
    toolOpenRequest: null,
  }),
}))
vi.mock("@renderer/stores/desktop-session-store", () => ({
  attachDesktopSessionEvents: () => () => undefined,
  isSessionPinned: () => false,
  useDesktopSessionStore: <T>(selector: (state: DesktopSessionState) => T): T =>
    selector(harness.state),
}))

import { MainLayout } from "./main-layout"

function stateWith(overrides: Partial<DesktopSessionState>): DesktopSessionState {
  return {
    appOperations: {},
    activeSessionId: null,
    applySessionUpdate: vi.fn(),
    archivedSessions: [],
    branch: null,
    branches: [],
    cancelQueuedPrompt: vi.fn(async () => undefined),
    checkoutBranch: vi.fn(async () => undefined),
    chooseProject: vi.fn(async () => undefined),
    createAndCheckoutBranch: vi.fn(async () => undefined),
    daemonStatus: { phase: "ready", message: "已连接", updatedAt: 1 },
    defaultModel: null,
    defaultPermissionMode: "default",
    defaultProvider: null,
    deleteSession: vi.fn(async () => undefined),
    editLatestMessage: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({}) as DesktopSessionState["forkSession"]),
    initialize: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    loadStatus: "ready",
    models: [],
    newConversationRuntime: {
      operations: {},
      pendingPromptEdit: null,
      pendingPromptSubmissions: {},
      queuedPromptActions: {},
    },
    openSession: vi.fn(async () => undefined),
    projectOperations: {},
    projects: [],
    promoteQueuedPrompt: vi.fn(async () => undefined),
    rebindProject: vi.fn(async () => undefined),
    refreshBootstrap: vi.fn(async () => undefined),
    refreshSelectedProjectGit: vi.fn(async () => false),
    removeProject: vi.fn(async () => undefined),
    renameProject: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    replyPermission: vi.fn(async () => undefined),
    selectModel: vi.fn(async () => undefined),
    selectOutsideProject: vi.fn(),
    selectPermissionMode: vi.fn(async () => undefined),
    selectProject: vi.fn(async () => undefined),
    selectedModel: null,
    selectedPermissionMode: "default",
    selectedProject: null,
    selectedProjectGit: false,
    selectedProjectGitCheckedAt: null,
    selectedProvider: null,
    sendMessage: vi.fn(async () => undefined),
    sessionRuntimes: {},
    sessions: [],
    sessionView: null,
    startNewConversation: vi.fn(),
    startConversationFrom: vi.fn(async () => undefined),
    startSession: vi.fn(async () => null),
    togglePinProject: vi.fn(async () => undefined),
    togglePinSession: vi.fn(async () => undefined),
    updateSessionModel: vi.fn(async () => undefined),
    updateSessionPermissionMode: vi.fn(async () => undefined),
    workspaceMode: "project",
    ...overrides,
  } as DesktopSessionState
}

function project(id: string, name: string): NonNullable<DesktopSessionState["selectedProject"]> {
  return { id, name, path: `D:\\${id}`, lastOpenedAt: 1, available: true }
}

function session(
  id: string,
  status: "idle" | "archived"
): NonNullable<DesktopSessionState["sessionView"]>["session"] {
  return {
    id,
    cwd: `D:\\${id}`,
    title: `${id} 会话`,
    model: "test-model",
    status,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function sessionView(
  id: string,
  status: "idle" | "archived"
): NonNullable<DesktopSessionState["sessionView"]> {
  return {
    cursor: 1,
    syncStatus: "connected",
    session: session(id, status),
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

function failedProjectOperation(projectId: string, error: string): DesktopOperation {
  return {
    id: `${projectId}:operation`,
    kind: "project-action" as const,
    phase: "failed" as const,
    sessionId: null,
    projectId,
    startedAt: 1,
    finishedAt: 2,
    error,
  }
}

function renderLayout(state: DesktopSessionState): string {
  harness.state = state
  return renderToStaticMarkup(createElement(MainLayout))
}

describe("MainLayout selected project operation error owner", () => {
  it("shows the selected project failure while the active conversation is archived", () => {
    const error = "归档会话中的项目操作失败"
    const selectedProject = project("project-a", "项目 A")
    const archivedSession = session("session-archived", "archived")
    const html = renderLayout(
      stateWith({
        activeSessionId: "session-archived",
        archivedSessions: [archivedSession],
        projects: [selectedProject],
        sessionView: sessionView("session-archived", "archived"),
        selectedProject,
        sessions: [archivedSession],
        projectOperations: {
          "project-a": {
            operation: failedProjectOperation("project-a", error),
          },
        },
      })
    )

    expect(html).toContain(error)
    expect(html.split(error)).toHaveLength(2)
    expect(html).toContain("此会话已归档，只能查看历史内容")
    expect(html).toContain("开始使用")
  })

  it.each([
    ["an active conversation", "session-active"],
    ["a new conversation", null],
  ])("shows a selected project failure once for %s", (_mode, activeSessionId) => {
    const error = "项目操作失败"
    const selectedProject = project("project-a", "项目 A")
    const activeSession = activeSessionId ? session(activeSessionId, "idle") : null
    const html = renderLayout(
      stateWith({
        activeSessionId,
        projects: [selectedProject],
        selectedProject,
        sessionView: activeSession ? sessionView(activeSession.id, "idle") : null,
        sessions: activeSession ? [activeSession] : [],
        projectOperations: {
          "project-a": {
            operation: failedProjectOperation("project-a", error),
          },
        },
      })
    )

    expect(html.split(error)).toHaveLength(2)
    expect(html).toContain("开始使用")
    expect(html).toContain(activeSession ? `${activeSession.id} 会话` : "new-conversation-composer")
  })

  it("does not show the previous selected project's failure after switching projects", () => {
    const state = stateWith({
      selectedProject: project("project-b", "项目 B"),
      projectOperations: {
        "project-a": {
          operation: failedProjectOperation("project-a", "项目 A 操作失败"),
        },
        "project-b": {
          operation: failedProjectOperation("project-b", "项目 B 操作失败"),
        },
      },
    })

    const html = renderLayout(state)

    expect(html).toContain("项目 B 操作失败")
    expect(html).not.toContain("项目 A 操作失败")
  })
})
