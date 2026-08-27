import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { DesktopOperation, DesktopSessionState } from "@renderer/stores/desktop-session/types"

const harness = vi.hoisted(() => ({ state: null as unknown as DesktopSessionState }))

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useRouter: () => ({
    history: { back: vi.fn(), forward: vi.fn(), canGoBack: () => false, canGoForward: () => false },
  }),
  useRouterState: () => 0,
}))

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children?: React.ReactNode }) => children,
  Panel: ({ children }: { children?: React.ReactNode }) => children,
  useDefaultLayout: () => ({ defaultLayout: null, onLayoutChanged: vi.fn() }),
  useGroupRef: () => ({ current: null }),
  usePanelRef: () => ({ current: null }),
}))

vi.mock("@renderer/components/desktop/conversation-page", () => ({ ConversationPane: () => null }))
vi.mock("@renderer/components/desktop/settings-page/settings-navigation", () => ({
  defaultSettingsSection: "general",
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
vi.mock("@renderer/components/desktop/layout/main-layout/sidebar", () => ({ Sidebar: () => null }))
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
  useDesktopSessionStore: <T>(selector: (state: DesktopSessionState) => T): T =>
    selector(harness.state),
}))

import { MainLayout } from "./main-layout"

function stateWith(overrides: Partial<DesktopSessionState>): DesktopSessionState {
  return {
    activeSessionId: null,
    sessionView: null,
    selectedProject: null,
    selectedProjectGit: false,
    sessions: [],
    startNewConversation: vi.fn(),
    chooseProject: vi.fn(),
    refreshSelectedProjectGit: vi.fn(async () => false),
    projectOperations: {},
    ...overrides,
  } as DesktopSessionState
}

function project(id: string, name: string): NonNullable<DesktopSessionState["selectedProject"]> {
  return { id, name, path: `D:\\${id}`, lastOpenedAt: 1, available: true }
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
    const html = renderLayout(
      stateWith({
        activeSessionId: "session-archived",
        sessionView: {
          session: { id: "session-archived", status: "archived" },
        } as DesktopSessionState["sessionView"],
        selectedProject: project("project-a", "项目 A"),
        projectOperations: {
          "project-a": {
            operation: failedProjectOperation("project-a", error),
          },
        },
      })
    )

    expect(html).toContain(error)
    expect(html.split(error)).toHaveLength(2)
  })

  it.each([
    ["an active conversation", "session-active"],
    ["a new conversation", null],
  ])("shows a selected project failure once for %s", (_mode, activeSessionId) => {
    const error = "项目操作失败"
    const html = renderLayout(
      stateWith({
        activeSessionId,
        selectedProject: project("project-a", "项目 A"),
        projectOperations: {
          "project-a": {
            operation: failedProjectOperation("project-a", error),
          },
        },
      })
    )

    expect(html.split(error)).toHaveLength(2)
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
