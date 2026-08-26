import { create } from "zustand"

import type {
  CreateDesktopSessionInput,
  DesktopBootstrapData,
  DesktopDaemonStatus,
  DesktopModel,
  DesktopPermissionMode,
  DesktopProject,
  DesktopSessionRecord,
  DesktopSessionView,
  DesktopWorkspaceMode,
} from "@shared/session-types"

type LoadStatus = "idle" | "loading" | "ready" | "error"

const persistedActiveSessionKey = "openharness.desktop.active-session.v1"

const initialDaemonStatus: DesktopDaemonStatus = {
  phase: "idle",
  message: "等待连接 daemon",
  updatedAt: Date.now(),
}

let daemonStatusEventsAttached = false

interface DesktopSessionState {
  loadStatus: LoadStatus
  daemonStatus: DesktopDaemonStatus
  error: string | null
  projects: DesktopProject[]
  sessions: DesktopSessionRecord[]
  archivedSessions: DesktopSessionRecord[]
  models: DesktopModel[]
  defaultModel: string | null
  defaultProvider: string | null
  defaultPermissionMode: DesktopPermissionMode
  selectedModel: string | null
  selectedProvider: string | null
  selectedPermissionMode: DesktopPermissionMode
  workspaceMode: DesktopWorkspaceMode
  selectedProject: DesktopProject | null
  selectedProjectGit: boolean
  branch: string | null
  branches: string[]
  activeSessionId: string | null
  sessionView: DesktopSessionView | null
  openingSession: boolean
  sending: boolean
  initialize: () => Promise<void>
  refreshBootstrap: () => Promise<void>
  startNewConversation: () => Promise<void>
  chooseProject: () => Promise<void>
  selectProject: (project: DesktopProject) => Promise<void>
  selectOutsideProject: () => void
  checkoutBranch: (branch: string) => Promise<void>
  createAndCheckoutBranch: (branch: string) => Promise<void>
  renameProject: (path: string, name: string) => Promise<void>
  togglePinProject: (path: string) => Promise<void>
  setProjectDefaultShell: (path: string, shell: string | null) => Promise<void>
  removeProject: (path: string) => Promise<void>
  rebindProject: (projectId: string) => Promise<void>
  selectModel: (model: DesktopModel) => Promise<void>
  selectPermissionMode: (mode: DesktopPermissionMode) => Promise<void>
  updateSessionModel: (sessionId: string, model: DesktopModel) => Promise<void>
  updateSessionPermissionMode: (
    sessionId: string,
    permissionMode: DesktopPermissionMode
  ) => Promise<void>
  openSession: (sessionId: string) => Promise<void>
  startConversationFrom: (session: DesktopSessionRecord) => Promise<void>
  forkSession: (
    sessionId: string,
    options?: { beforeMessageId?: string; afterMessageId?: string }
  ) => Promise<DesktopSessionRecord>
  renameSession: (sessionId: string, title: string) => Promise<void>
  togglePinSession: (sessionId: string) => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  startSession: (content: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  editLatestMessage: (content: string) => Promise<void>
  interrupt: () => Promise<void>
  replyPermission: (
    permissionId: string,
    status: "approved" | "denied",
    decision?: "once" | "session"
  ) => Promise<void>
  applySessionUpdate: (view: DesktopSessionView) => void
  clearError: () => void
}

export const useDesktopSessionStore = create<DesktopSessionState>((set, get) => ({
  loadStatus: "idle",
  daemonStatus: initialDaemonStatus,
  error: null,
  projects: [],
  sessions: [],
  archivedSessions: [],
  models: [],
  defaultModel: null,
  defaultProvider: null,
  defaultPermissionMode: "default",
  selectedModel: null,
  selectedProvider: null,
  selectedPermissionMode: "default",
  workspaceMode: "project",
  selectedProject: null,
  selectedProjectGit: false,
  branch: null,
  branches: [],
  activeSessionId: null,
  sessionView: null,
  openingSession: false,
  sending: false,

  async initialize() {
    if (get().loadStatus === "loading" || get().loadStatus === "ready") return
    ensureDesktopDaemonStatusEvents()
    set({
      loadStatus: "loading",
      daemonStatus: {
        phase: "discovering",
        message: "正在观察 daemon 状态",
        updatedAt: Date.now(),
      },
      error: null,
    })
    try {
      const daemonStatus = await window.desktop.sessions.daemonStatus()
      set({ daemonStatus })
      const data = await window.desktop.sessions.bootstrap()
      const latestDaemonStatus = await window.desktop.sessions
        .daemonStatus()
        .catch(() => get().daemonStatus)
      const workspaceMode =
        get().workspaceMode === "outside_project" || data.projects.length === 0
          ? "outside_project"
          : "project"
      const selectedProject = resolveInitialProject(data, get().selectedProject, workspaceMode)
      const sessions = sortSessions(data.sessions)
      const archivedSessions = sortSessions(data.archivedSessions)
      const persistedSessionId = readPersistedActiveSessionId()
      set({
        loadStatus: "ready",
        daemonStatus: latestDaemonStatus,
        projects: data.projects,
        sessions,
        archivedSessions,
        models: data.models,
        defaultModel: data.defaultModel,
        defaultProvider: data.defaultProvider ?? null,
        defaultPermissionMode: data.defaultPermissionMode,
        selectedModel: data.defaultModel,
        selectedProvider: data.defaultProvider ?? null,
        selectedPermissionMode: data.defaultPermissionMode,
        workspaceMode,
        selectedProject,
        selectedProjectGit: false,
        branches: [],
        error: null,
      })
      if (selectedProject) await get().selectProject(selectedProject)
      if (persistedSessionId && sessions.some((session) => session.id === persistedSessionId)) {
        await get().openSession(persistedSessionId)
      } else if (persistedSessionId) {
        clearPersistedActiveSessionId()
      }
    } catch (error) {
      const daemonStatus = await window.desktop.sessions
        .daemonStatus()
        .catch(() => get().daemonStatus)
      set({ loadStatus: "error", daemonStatus, error: errorMessage(error) })
    }
  },

  async refreshBootstrap() {
    const data = await window.desktop.sessions.bootstrap()
    set((state) => ({
      ...applyBootstrapData(data, state.selectedProject, state.workspaceMode, null, null),
      ...(state.activeSessionId
        ? {
            selectedModel: state.selectedModel,
            selectedProvider: state.selectedProvider,
            selectedPermissionMode: state.selectedPermissionMode,
          }
        : {}),
    }))
  },

  async startNewConversation() {
    await window.desktop.sessions.close()
    clearPersistedActiveSessionId()
    set({
      activeSessionId: null,
      sessionView: null,
      selectedModel: get().defaultModel,
      selectedProvider: get().defaultProvider,
      selectedPermissionMode: get().defaultPermissionMode,
      openingSession: false,
      sending: false,
      error: null,
    })
  },

  async chooseProject() {
    try {
      const details = await window.desktop.sessions.chooseProject()
      if (!details) return
      set((state) => ({
        projects: upsertProject(state.projects, details.project),
        workspaceMode: "project",
        selectedProject: details.project,
        selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
        branch: details.branch,
        branches: details.branches ?? [],
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async selectProject(project) {
    set({
      selectedProject: project,
      workspaceMode: "project",
      selectedProjectGit: false,
      branch: null,
      branches: [],
      error: null,
    })
    try {
      const details = await window.desktop.sessions.inspectProject(project.path)
      set((state) => ({
        projects: upsertProject(state.projects, details.project),
        selectedProject: details.project,
        selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
        branch: details.branch,
        branches: details.branches ?? [],
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  selectOutsideProject() {
    set({
      workspaceMode: "outside_project",
      selectedProject: null,
      selectedProjectGit: false,
      branch: null,
      branches: [],
      error: null,
    })
  },

  async checkoutBranch(branch) {
    const selectedProject = get().selectedProject
    if (!selectedProject) return
    try {
      const details = await window.desktop.sessions.checkoutBranch({
        path: selectedProject.path,
        branch,
      })
      set((state) => ({
        projects: upsertProject(state.projects, details.project),
        selectedProject: details.project,
        selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
        branch: details.branch,
        branches: details.branches ?? [],
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async createAndCheckoutBranch(branch) {
    const selectedProject = get().selectedProject
    if (!selectedProject) return
    try {
      const details = await window.desktop.sessions.createBranch({
        path: selectedProject.path,
        branch,
      })
      set((state) => ({
        projects: upsertProject(state.projects, details.project),
        selectedProject: details.project,
        selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
        branch: details.branch,
        branches: details.branches ?? [],
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async renameProject(path, name) {
    const normalizedName = name.replace(/\s+/g, " ").trim()
    if (!normalizedName) return
    try {
      const existing = get().projects.find((project) => samePath(project.path, path))
      if (!existing) return
      const project = await window.desktop.sessions.renameProject({
        projectId: existing.id,
        name: normalizedName,
      })
      set((state) => ({
        projects: upsertProject(state.projects, project),
        selectedProject: samePath(state.selectedProject?.path ?? "", path)
          ? project
          : state.selectedProject,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async togglePinProject(path) {
    const existing = get().projects.find((project) => samePath(project.path, path))
    if (!existing) return
    try {
      const project = await window.desktop.sessions.setProjectPinned({
        projectId: existing.id,
        pinned: !existing.pinnedAt,
      })
      set((state) => ({
        projects: upsertProject(state.projects, project),
        selectedProject: samePath(state.selectedProject?.path ?? "", path)
          ? project
          : state.selectedProject,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async setProjectDefaultShell(path, shell) {
    const existing = get().projects.find((project) => samePath(project.path, path))
    if (!existing) return
    const normalizedShell = shell?.replace(/\s+/g, " ").trim() || null
    try {
      const project = await window.desktop.sessions.setProjectDefaultShell({
        projectId: existing.id,
        shell: normalizedShell,
      })
      set((state) => ({
        projects: upsertProject(state.projects, project),
        selectedProject: samePath(state.selectedProject?.path ?? "", path)
          ? project
          : state.selectedProject,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async removeProject(path) {
    try {
      const existing = get().projects.find((project) => samePath(project.path, path))
      if (!existing) return
      await window.desktop.sessions.removeProject(existing.id)
      set((state) => {
        const projects = state.projects.filter((project) => !samePath(project.path, path))
        const removedSelected = samePath(state.selectedProject?.path ?? "", path)
        return {
          projects,
          selectedProject: removedSelected ? (projects[0] ?? null) : state.selectedProject,
          workspaceMode:
            removedSelected && projects.length === 0 ? "outside_project" : state.workspaceMode,
          selectedProjectGit: removedSelected ? false : state.selectedProjectGit,
          branch: removedSelected ? null : state.branch,
          branches: removedSelected ? [] : state.branches,
          error: null,
        }
      })
      const project = get().selectedProject
      if (project) await get().selectProject(project)
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async rebindProject(projectId) {
    try {
      const project = await window.desktop.sessions.rebindProject(projectId)
      if (!project) return
      set((state) => ({
        projects: upsertProject(state.projects, project),
        selectedProject: state.selectedProject?.id === projectId ? project : state.selectedProject,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async selectModel(model) {
    const previousModel = get().selectedModel
    const previousProvider = get().selectedProvider
    set({
      selectedModel: model.id,
      selectedProvider: model.providerName,
      defaultModel: model.id,
      defaultProvider: model.providerName,
      error: null,
    })
    try {
      const data = await window.desktop.sessions.setDefaultModel({
        model: model.id,
        provider: model.providerName,
      })
      set((state) =>
        applyBootstrapData(
          data,
          state.selectedProject,
          state.workspaceMode,
          model.id,
          model.providerName
        )
      )
    } catch (error) {
      set({
        selectedModel: previousModel,
        selectedProvider: previousProvider,
        defaultModel: previousModel,
        defaultProvider: previousProvider,
        error: errorMessage(error),
      })
    }
  },

  async selectPermissionMode(permissionMode) {
    const previous = get().selectedPermissionMode
    set({
      selectedPermissionMode: permissionMode,
      defaultPermissionMode: permissionMode,
      error: null,
    })
    try {
      const data = await window.desktop.sessions.setDefaultPermissionMode({ permissionMode })
      set((state) => ({
        ...applyBootstrapData(
          data,
          state.selectedProject,
          state.workspaceMode,
          state.selectedModel,
          state.selectedProvider
        ),
        selectedPermissionMode: data.defaultPermissionMode,
      }))
    } catch (error) {
      set({
        selectedPermissionMode: previous,
        defaultPermissionMode: previous,
        error: errorMessage(error),
      })
    }
  },

  async updateSessionModel(sessionId, model) {
    try {
      const session = await window.desktop.sessions.updateModel({
        sessionId,
        model: model.id,
        provider: model.providerName,
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedModel: state.activeSessionId === sessionId ? session.model : state.selectedModel,
        selectedProvider:
          state.activeSessionId === sessionId
            ? sessionProvider(session, model.providerName)
            : state.selectedProvider,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async updateSessionPermissionMode(sessionId, permissionMode) {
    try {
      const session = await window.desktop.sessions.updatePermissionMode({
        sessionId,
        permissionMode,
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedPermissionMode:
          state.activeSessionId === sessionId
            ? sessionPermissionMode(session)
            : state.selectedPermissionMode,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async openSession(sessionId) {
    if (!sessionId) return
    set({ activeSessionId: sessionId, sessionView: null, openingSession: true, error: null })
    try {
      const view = await window.desktop.sessions.open(sessionId)
      if (get().activeSessionId !== sessionId) return
      writePersistedActiveSessionId(sessionId)
      const workspace = resolveSessionWorkspace(get().projects, view.session)
      set((state) => ({
        ...workspace,
        sessionView: view,
        openingSession: false,
        selectedModel: view.session.model,
        selectedProvider: sessionProvider(view.session, state.defaultProvider),
        selectedPermissionMode: sessionPermissionMode(view.session, state.defaultPermissionMode),
        sessions:
          view.session.status === "archived"
            ? state.sessions.filter((session) => session.id !== view.session.id)
            : upsertSession(state.sessions, view.session),
        archivedSessions:
          view.session.status === "archived"
            ? upsertSession(state.archivedSessions, view.session)
            : state.archivedSessions,
      }))
      if (workspace.selectedProject) {
        try {
          const details = await window.desktop.sessions.inspectProject(
            workspace.selectedProject.path
          )
          if (get().activeSessionId !== sessionId) return
          set((state) => ({
            projects: upsertProject(state.projects, details.project),
            selectedProject: details.project,
            selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
            branch: details.branch,
            branches: details.branches ?? [],
          }))
        } catch {
          if (get().activeSessionId === sessionId) {
            set({ selectedProjectGit: false, branch: null, branches: [] })
          }
        }
      }
    } catch (error) {
      if (get().activeSessionId === sessionId) {
        clearPersistedActiveSessionId()
        set({ openingSession: false, error: errorMessage(error) })
      }
    }
  },

  async startConversationFrom(session) {
    await window.desktop.sessions.close()
    clearPersistedActiveSessionId()
    const workspace = resolveSessionWorkspace(get().projects, session)
    set({
      activeSessionId: null,
      sessionView: null,
      openingSession: false,
      sending: false,
      ...workspace,
      selectedModel: session.model,
      selectedProvider: sessionProvider(session, get().defaultProvider),
      selectedPermissionMode: sessionPermissionMode(session, get().defaultPermissionMode),
      selectedProjectGit: false,
      branch: null,
      branches: [],
      error: null,
    })
    if (workspace.selectedProject) await get().selectProject(workspace.selectedProject)
  },

  async forkSession(sessionId, options) {
    if (!sessionId) throw new Error("会话 ID 不能为空")
    try {
      const session = await window.desktop.sessions.fork({
        sessionId,
        ...(options?.beforeMessageId ? { beforeMessageId: options.beforeMessageId } : {}),
        ...(options?.afterMessageId ? { afterMessageId: options.afterMessageId } : {}),
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        archivedSessions: state.archivedSessions.filter((item) => item.id !== session.id),
        error: null,
      }))
      await get().openSession(session.id)
      return session
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async renameSession(sessionId, title) {
    const normalizedTitle = title.replace(/\s+/g, " ").trim()
    if (!normalizedTitle) return
    try {
      const session = await window.desktop.sessions.rename({ sessionId, title: normalizedTitle })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async togglePinSession(sessionId) {
    const existing = get().sessions.find((session) => session.id === sessionId)
    if (!existing) return
    try {
      const session = await window.desktop.sessions.setPinned({
        sessionId,
        pinned: !isSessionPinned(existing),
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null,
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async archiveSession(sessionId) {
    const existing = get().sessions.find((session) => session.id === sessionId)
    if (!existing) return
    try {
      const archived = await window.desktop.sessions.archive(sessionId)
      const isActive = get().activeSessionId === sessionId
      set((state) => ({
        ...(isActive ? resolveSessionWorkspace(state.projects, existing) : {}),
        sessions: state.sessions.filter((session) => session.id !== sessionId),
        archivedSessions: upsertSession(state.archivedSessions, archived),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView: isActive ? null : state.sessionView,
        openingSession: false,
        sending: false,
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
        error: null,
      }))
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
      }
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async deleteSession(sessionId) {
    const existing =
      get().sessions.find((session) => session.id === sessionId) ??
      get().archivedSessions.find((session) => session.id === sessionId)
    if (!existing) return
    try {
      const deletedSessionIds = await window.desktop.sessions.delete(sessionId)
      const deleted = new Set(deletedSessionIds)
      const activeSessionId = get().activeSessionId
      const isActive = activeSessionId !== null && deleted.has(activeSessionId)
      set((state) => ({
        ...(isActive ? resolveSessionWorkspace(state.projects, existing) : {}),
        sessions: state.sessions.filter((session) => !deleted.has(session.id)),
        archivedSessions: state.archivedSessions.filter((session) => !deleted.has(session.id)),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView:
          state.sessionView && deleted.has(state.sessionView.session.id) ? null : state.sessionView,
        openingSession: isActive ? false : state.openingSession,
        sending: isActive ? false : state.sending,
        selectedModel: isActive ? existing.model : state.selectedModel,
        selectedProvider: isActive
          ? sessionProvider(existing, state.defaultProvider)
          : state.selectedProvider,
        selectedPermissionMode: isActive
          ? sessionPermissionMode(existing, state.defaultPermissionMode)
          : state.selectedPermissionMode,
        error: null,
      }))
      if (isActive) {
        clearPersistedActiveSessionId()
        const project = get().selectedProject
        if (project) await get().selectProject(project)
      }
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async startSession(content) {
    const prompt = content.trim()
    const {
      selectedProject,
      workspaceMode,
      selectedModel,
      selectedProvider,
      defaultModel,
      defaultProvider,
      selectedPermissionMode,
    } = get()
    const model = selectedModel ?? defaultModel
    const provider = selectedProvider ?? defaultProvider
    if (!prompt || get().sending) return
    if (workspaceMode === "project" && !selectedProject) {
      set({ error: "请先选择一个项目目录。" })
      return
    }
    if (!model) {
      set({ error: "没有可用模型，请先配置模型。" })
      return
    }

    set({ sending: true, error: null })
    try {
      const sessionInput: CreateDesktopSessionInput =
        workspaceMode === "project" && selectedProject
          ? {
              projectId: selectedProject.id,
              cwd: selectedProject.path,
              model,
              ...(provider ? { provider } : {}),
              permissionMode: selectedPermissionMode,
            }
          : {
              model,
              ...(provider ? { provider } : {}),
              permissionMode: selectedPermissionMode,
            }
      const session = await window.desktop.sessions.create(sessionInput)
      set((state) => ({
        activeSessionId: session.id,
        sessions: upsertSession(state.sessions, session),
        openingSession: true,
      }))
      writePersistedActiveSessionId(session.id)
      const view = await window.desktop.sessions.open(session.id)
      set((state) => ({
        sessionView: view,
        openingSession: false,
        selectedModel: view.session.model,
        selectedProvider: sessionProvider(view.session, provider),
        selectedPermissionMode: sessionPermissionMode(view.session, state.defaultPermissionMode),
      }))
      await window.desktop.sessions.sendPrompt({ sessionId: session.id, content: prompt })
      const title = formatSessionTitle(prompt)
      set((state) => {
        const titledSession = { ...session, title, updatedAt: Date.now() }
        return {
          sessions: upsertSession(state.sessions, titledSession),
          sessionView:
            state.sessionView?.session.id === session.id
              ? {
                  ...state.sessionView,
                  session: { ...state.sessionView.session, title },
                }
              : state.sessionView,
        }
      })
    } catch (error) {
      set({ openingSession: false, error: errorMessage(error) })
      throw error
    } finally {
      set({ sending: false })
    }
  },

  async sendMessage(content) {
    const prompt = content.trim()
    const sessionId = get().activeSessionId
    if (!prompt || !sessionId || get().sending) return
    set({ sending: true, error: null })
    try {
      await window.desktop.sessions.sendPrompt({ sessionId, content: prompt })
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    } finally {
      set({ sending: false })
    }
  },

  async editLatestMessage(content) {
    const prompt = content.trim()
    const sessionId = get().activeSessionId
    if (!prompt || !sessionId || get().sending) return
    set({ sending: true, error: null })
    try {
      await window.desktop.sessions.editLatestPrompt({ sessionId, content: prompt })
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    } finally {
      set({ sending: false })
    }
  },

  async interrupt() {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    try {
      await window.desktop.sessions.interrupt(sessionId)
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async replyPermission(permissionId, status, decision = "once") {
    try {
      await window.desktop.sessions.replyPermission({ permissionId, status, decision })
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  applySessionUpdate(view) {
    const current = get().sessionView
    if (get().activeSessionId !== view.session.id) return
    if (current && view.cursor < current.cursor) return
    if (view.session.status === "archived") clearPersistedActiveSessionId()
    else writePersistedActiveSessionId(view.session.id)
    set((state) => {
      const knownSession = state.sessions.find((session) => session.id === view.session.id)
      const session =
        knownSession &&
        isPlaceholderTitle(view.session.title) &&
        !isPlaceholderTitle(knownSession.title)
          ? { ...view.session, title: knownSession.title }
          : view.session

      return {
        sessionView: { ...view, session },
        openingSession: false,
        selectedModel: session.model,
        selectedProvider: sessionProvider(session, state.defaultProvider),
        selectedPermissionMode: sessionPermissionMode(session, state.defaultPermissionMode),
        sessions:
          session.status === "archived"
            ? state.sessions.filter((item) => item.id !== session.id)
            : upsertSession(state.sessions, session),
        archivedSessions:
          session.status === "archived"
            ? upsertSession(state.archivedSessions, session)
            : state.archivedSessions,
      }
    })
  },

  clearError() {
    set({ error: null })
  },
}))

export function attachDesktopSessionEvents(): () => void {
  ensureDesktopDaemonStatusEvents()
  return window.desktop.sessions.onUpdated((view) => {
    useDesktopSessionStore.getState().applySessionUpdate(view)
  })
}

function ensureDesktopDaemonStatusEvents(): void {
  if (daemonStatusEventsAttached) return
  daemonStatusEventsAttached = true
  window.desktop.sessions.onDaemonStatusChanged((daemonStatus) => {
    useDesktopSessionStore.setState({ daemonStatus })
  })
}

function applyBootstrapData(
  data: DesktopBootstrapData,
  currentProject: DesktopProject | null,
  workspaceMode: DesktopWorkspaceMode,
  preferredModel: string | null,
  preferredProvider: string | null
): Partial<DesktopSessionState> {
  const resolvedWorkspaceMode =
    workspaceMode === "project" && data.projects.length === 0 ? "outside_project" : workspaceMode
  const selectedProject = resolveInitialProject(data, currentProject, resolvedWorkspaceMode)
  const preferredExists =
    preferredModel &&
    data.models.some(
      (item) => item.id === preferredModel && item.providerName === preferredProvider
    )
  const model = preferredExists ? preferredModel : data.defaultModel
  const provider = preferredExists ? preferredProvider : (data.defaultProvider ?? null)
  return {
    loadStatus: "ready",
    projects: data.projects,
    sessions: sortSessions(data.sessions),
    archivedSessions: sortSessions(data.archivedSessions),
    models: data.models,
    defaultModel: data.defaultModel,
    defaultProvider: data.defaultProvider ?? null,
    defaultPermissionMode: data.defaultPermissionMode,
    selectedModel: model,
    selectedProvider: provider,
    selectedPermissionMode: data.defaultPermissionMode,
    workspaceMode: resolvedWorkspaceMode,
    selectedProject,
    error: null,
  }
}

function resolveInitialProject(
  data: DesktopBootstrapData,
  current: DesktopProject | null,
  workspaceMode: DesktopWorkspaceMode
): DesktopProject | null {
  if (workspaceMode === "outside_project") return null
  if (current) {
    const match = data.projects.find((project) => samePath(project.path, current.path))
    if (match) return match
  }
  return data.projects[0] ?? null
}

function resolveSessionWorkspace(
  projects: DesktopProject[],
  session: DesktopSessionRecord
): Pick<
  DesktopSessionState,
  "workspaceMode" | "selectedProject" | "selectedProjectGit" | "branch" | "branches"
> {
  if (session.workspaceMode === "outside_project" || !session.projectId) {
    return {
      workspaceMode: "outside_project",
      selectedProject: null,
      selectedProjectGit: false,
      branch: null,
      branches: [],
    }
  }
  const project =
    projects.find((item) => item.id === session.projectId) ??
    projects.find((item) => samePath(item.path, session.cwd)) ??
    projectFromSession(session)
  return {
    workspaceMode: "project",
    selectedProject: project,
    selectedProjectGit: false,
    branch: null,
    branches: [],
  }
}

function readPersistedActiveSessionId(): string | null {
  try {
    const value = localStorage.getItem(persistedActiveSessionKey)?.trim()
    return value || null
  } catch {
    return null
  }
}

function writePersistedActiveSessionId(sessionId: string): void {
  try {
    localStorage.setItem(persistedActiveSessionKey, sessionId)
  } catch {
    // Session restore is a convenience feature; storage failures should not interrupt chat use.
  }
}

function clearPersistedActiveSessionId(): void {
  try {
    localStorage.removeItem(persistedActiveSessionKey)
  } catch {
    // Ignore storage failures for the same reason as writes.
  }
}

function upsertProject(projects: DesktopProject[], project: DesktopProject): DesktopProject[] {
  return [project, ...projects.filter((item) => !samePath(item.path, project.path))].sort(
    (a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.lastOpenedAt - a.lastOpenedAt
  )
}

function upsertSession(
  sessions: DesktopSessionRecord[],
  session: DesktopSessionRecord
): DesktopSessionRecord[] {
  return sortSessions([session, ...sessions.filter((item) => item.id !== session.id)])
}

function sortSessions(sessions: DesktopSessionRecord[]): DesktopSessionRecord[] {
  return [...sessions].sort((a, b) => {
    const pinDifference = sessionPinnedAt(b) - sessionPinnedAt(a)
    return pinDifference || b.updatedAt - a.updatedAt
  })
}

export function isSessionPinned(session: DesktopSessionRecord): boolean {
  return sessionPinnedAt(session) > 0
}

function sessionPermissionMode(
  session: DesktopSessionRecord,
  fallback: DesktopPermissionMode = "default"
): DesktopPermissionMode {
  const runtime = session.metadata["runtime"]
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return fallback
  const mode = (runtime as Record<string, unknown>)["permissionMode"]
  return mode === "default" || mode === "plan" || mode === "full_auto" ? mode : fallback
}

function sessionProvider(
  session: DesktopSessionRecord,
  fallback: string | null = null
): string | null {
  const runtime = session.metadata["runtime"]
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return fallback
  const provider = (runtime as Record<string, unknown>)["provider"]
  return typeof provider === "string" && provider.trim() ? provider.trim() : fallback
}

function sessionPinnedAt(session: DesktopSessionRecord): number {
  const desktop = session.metadata["desktop"]
  if (!desktop || typeof desktop !== "object" || Array.isArray(desktop)) return 0
  const pinnedAt = (desktop as Record<string, unknown>)["pinnedAt"]
  return typeof pinnedAt === "number" ? pinnedAt : 0
}

function projectFromSession(session: DesktopSessionRecord): DesktopProject {
  const normalized = session.cwd.replace(/[\\/]+$/, "")
  return {
    id: session.projectId ?? session.cwd,
    name: normalized.split(/[\\/]/).pop() || session.cwd,
    path: session.cwd,
    lastOpenedAt: session.updatedAt,
    ...(typeof session.metadata["defaultShell"] === "string"
      ? { defaultShell: session.metadata["defaultShell"] }
      : {}),
    available: true,
  }
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}

function formatSessionTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim()
  const firstSentence = normalized.match(/^.*?[。！？.!?]/)?.[0] ?? normalized
  return [...firstSentence].slice(0, 20).join("")
}

function isPlaceholderTitle(title: string): boolean {
  const normalized = title.trim()
  return normalized === "" || normalized === "TUI"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.replace(/^Error invoking remote method '[^']+': /, "")
  return String(error)
}
