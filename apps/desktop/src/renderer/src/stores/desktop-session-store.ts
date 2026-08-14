import { create } from 'zustand'

import type {
  DesktopBootstrapData,
  DesktopModel,
  DesktopProject,
  DesktopSessionRecord,
  DesktopSessionView
} from '@shared/session-types'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

interface DesktopSessionState {
  loadStatus: LoadStatus
  error: string | null
  projects: DesktopProject[]
  sessions: DesktopSessionRecord[]
  archivedSessions: DesktopSessionRecord[]
  models: DesktopModel[]
  defaultModel: string | null
  selectedModel: string | null
  selectedProject: DesktopProject | null
  branch: string | null
  activeSessionId: string | null
  sessionView: DesktopSessionView | null
  openingSession: boolean
  sending: boolean
  initialize: () => Promise<void>
  startNewConversation: () => Promise<void>
  chooseProject: () => Promise<void>
  selectProject: (project: DesktopProject) => Promise<void>
  selectModel: (model: string) => void
  openSession: (sessionId: string) => Promise<void>
  startConversationFrom: (session: DesktopSessionRecord) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  togglePinSession: (sessionId: string) => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
  startSession: (content: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  interrupt: () => Promise<void>
  replyPermission: (
    permissionId: string,
    status: 'approved' | 'denied',
    decision?: 'once' | 'session'
  ) => Promise<void>
  applySessionUpdate: (view: DesktopSessionView) => void
  clearError: () => void
}

export const useDesktopSessionStore = create<DesktopSessionState>((set, get) => ({
  loadStatus: 'idle',
  error: null,
  projects: [],
  sessions: [],
  archivedSessions: [],
  models: [],
  defaultModel: null,
  selectedModel: null,
  selectedProject: null,
  branch: null,
  activeSessionId: null,
  sessionView: null,
  openingSession: false,
  sending: false,

  async initialize() {
    if (get().loadStatus === 'loading' || get().loadStatus === 'ready') return
    set({ loadStatus: 'loading', error: null })
    try {
      const data = await window.desktop.sessions.bootstrap()
      const selectedProject = resolveInitialProject(data, get().selectedProject)
      set({
        loadStatus: 'ready',
        projects: data.projects,
        sessions: sortSessions(data.sessions),
        archivedSessions: sortSessions(data.archivedSessions),
        models: data.models,
        defaultModel: data.defaultModel,
        selectedModel: data.defaultModel,
        selectedProject,
        error: null
      })
      if (selectedProject) await get().selectProject(selectedProject)
    } catch (error) {
      set({ loadStatus: 'error', error: errorMessage(error) })
    }
  },

  async startNewConversation() {
    await window.desktop.sessions.close()
    set({
      activeSessionId: null,
      sessionView: null,
      openingSession: false,
      sending: false,
      error: null
    })
  },

  async chooseProject() {
    try {
      const details = await window.desktop.sessions.chooseProject()
      if (!details) return
      set((state) => ({
        projects: upsertProject(state.projects, details.project),
        selectedProject: details.project,
        branch: details.branch,
        error: null
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async selectProject(project) {
    set({ selectedProject: project, branch: null, error: null })
    try {
      const details = await window.desktop.sessions.inspectProject(project.path)
      set((state) => ({
        projects: upsertProject(state.projects, details.project),
        selectedProject: details.project,
        branch: details.branch
      }))
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  selectModel(model) {
    set({ selectedModel: model })
  },

  async openSession(sessionId) {
    if (!sessionId) return
    set({ activeSessionId: sessionId, sessionView: null, openingSession: true, error: null })
    try {
      const view = await window.desktop.sessions.open(sessionId)
      if (get().activeSessionId !== sessionId) return
      set((state) => ({
        sessionView: view,
        openingSession: false,
        selectedProject:
          state.projects.find((project) => samePath(project.path, view.session.cwd)) ??
          projectFromSession(view.session),
        selectedModel: view.session.model,
        sessions:
          view.session.status === 'archived'
            ? state.sessions.filter((session) => session.id !== view.session.id)
            : upsertSession(state.sessions, view.session),
        archivedSessions:
          view.session.status === 'archived'
            ? upsertSession(state.archivedSessions, view.session)
            : state.archivedSessions
      }))
    } catch (error) {
      if (get().activeSessionId === sessionId) {
        set({ openingSession: false, error: errorMessage(error) })
      }
    }
  },

  async startConversationFrom(session) {
    await window.desktop.sessions.close()
    const project =
      get().projects.find((item) => samePath(item.path, session.cwd)) ?? projectFromSession(session)
    set({
      activeSessionId: null,
      sessionView: null,
      openingSession: false,
      sending: false,
      selectedProject: project,
      selectedModel: session.model,
      branch: null,
      error: null
    })
    await get().selectProject(project)
  },

  async renameSession(sessionId, title) {
    const normalizedTitle = title.replace(/\s+/g, ' ').trim()
    if (!normalizedTitle) return
    try {
      const session = await window.desktop.sessions.rename({ sessionId, title: normalizedTitle })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null
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
        pinned: !isSessionPinned(existing)
      })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
        error: null
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
        sessions: state.sessions.filter((session) => session.id !== sessionId),
        archivedSessions: upsertSession(state.archivedSessions, archived),
        activeSessionId: isActive ? null : state.activeSessionId,
        sessionView: isActive ? null : state.sessionView,
        openingSession: false,
        sending: false,
        selectedProject: isActive
          ? state.projects.find((project) => samePath(project.path, existing.cwd)) ??
            projectFromSession(existing)
          : state.selectedProject,
        selectedModel: isActive ? existing.model : state.selectedModel,
        error: null
      }))
      if (isActive) {
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
    const { selectedProject, selectedModel, defaultModel } = get()
    const model = selectedModel ?? defaultModel
    if (!prompt || get().sending) return
    if (!selectedProject) {
      set({ error: '请先选择一个项目目录。' })
      return
    }
    if (!model) {
      set({ error: '没有可用模型，请先配置模型。' })
      return
    }

    set({ sending: true, error: null })
    try {
      const session = await window.desktop.sessions.create({
        cwd: selectedProject.path,
        model
      })
      set((state) => ({
        activeSessionId: session.id,
        sessions: upsertSession(state.sessions, session),
        openingSession: true
      }))
      const view = await window.desktop.sessions.open(session.id)
      set({ sessionView: view, openingSession: false })
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
                  session: { ...state.sessionView.session, title }
                }
              : state.sessionView
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

  async interrupt() {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    try {
      await window.desktop.sessions.interrupt(sessionId)
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async replyPermission(permissionId, status, decision = 'once') {
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
        sessions:
          session.status === 'archived'
            ? state.sessions.filter((item) => item.id !== session.id)
            : upsertSession(state.sessions, session),
        archivedSessions:
          session.status === 'archived'
            ? upsertSession(state.archivedSessions, session)
            : state.archivedSessions
      }
    })
  },

  clearError() {
    set({ error: null })
  }
}))

export function attachDesktopSessionEvents(): () => void {
  return window.desktop.sessions.onUpdated((view) => {
    useDesktopSessionStore.getState().applySessionUpdate(view)
  })
}

function resolveInitialProject(
  data: DesktopBootstrapData,
  current: DesktopProject | null
): DesktopProject | null {
  if (current) {
    const match = data.projects.find((project) => samePath(project.path, current.path))
    if (match) return match
  }
  return data.projects[0] ?? null
}

function upsertProject(projects: DesktopProject[], project: DesktopProject): DesktopProject[] {
  return [project, ...projects.filter((item) => !samePath(item.path, project.path))].sort(
    (a, b) => b.lastOpenedAt - a.lastOpenedAt
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

function sessionPinnedAt(session: DesktopSessionRecord): number {
  const desktop = session.metadata['desktop']
  if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) return 0
  const pinnedAt = (desktop as Record<string, unknown>)['pinnedAt']
  return typeof pinnedAt === 'number' ? pinnedAt : 0
}

function projectFromSession(session: DesktopSessionRecord): DesktopProject {
  const normalized = session.cwd.replace(/[\\/]+$/, '')
  return {
    name: normalized.split(/[\\/]/).pop() || session.cwd,
    path: session.cwd,
    lastOpenedAt: session.updatedAt
  }
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right)
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
}

function formatSessionTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  const firstSentence = normalized.match(/^.*?[。！？.!?]/)?.[0] ?? normalized
  return [...firstSentence].slice(0, 20).join('')
}

function isPlaceholderTitle(title: string): boolean {
  const normalized = title.trim()
  return normalized === '' || normalized === 'TUI'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': /, '')
  return String(error)
}
