import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

import {
  OpenHarnessClient,
  syncEvents,
  type OpenHarnessClientState,
  type SessionRecord,
  type SyncEventUpdate,
} from "@openharness/client"
import {
  clearDaemonRegistry,
  createBearerToken,
  readDaemonRegistry,
  startOpenHarnessDaemon,
  writeDaemonRegistry,
  type OpenHarnessHttpServer,
} from "@openharness/server"
import { app, BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from "electron"
import Store from "electron-store"

import { IpcEvents } from "../../../shared/ipc-channels"
import type {
  CreateDesktopSessionInput,
  DesktopBootstrapData,
  DesktopModel,
  DesktopProject,
  DesktopProjectDetails,
  DesktopSessionView,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SendDesktopPromptInput,
} from "../../../shared/session-types"

interface DesktopPreferences {
  recentProjects: DesktopProject[]
  projectPreferences: Record<string, DesktopProjectPreference>
}

interface DesktopProjectPreference {
  name?: string
  pinnedAt?: number
  hidden?: boolean
}

interface SessionSubscription {
  controller: AbortController
  sessionId: string
}

const preferences = new Store<DesktopPreferences>({
  name: "desktop-preferences",
  defaults: { recentProjects: [], projectPreferences: {} },
})

class DesktopSessionService {
  private clientPromise: Promise<OpenHarnessClient> | null = null
  private embeddedServer: OpenHarnessHttpServer | null = null
  private embeddedUrl: string | null = null
  private readonly subscriptions = new Map<number, SessionSubscription>()

  async bootstrap(): Promise<DesktopBootstrapData> {
    const client = await this.getClient()
    const [settings, providers, allSessions] = await Promise.all([
      client.getSettings(),
      client.listModels(),
      client.listSessions({ includeArchived: true, limit: 400 }),
    ])
    const sessions = allSessions.filter((session) => session.status !== "archived")
    const archivedSessions = allSessions.filter((session) => session.status === "archived")
    const models = providers.flatMap((provider) => provider.models)
    const configuredModel = typeof settings["model"] === "string" ? settings["model"] : undefined
    const defaultModel = configuredModel ?? models[0]?.id

    if (!defaultModel) {
      throw new Error("没有找到可用模型，请先在 OpenHarness 设置中配置模型。")
    }

    const normalizedModels = ensureConfiguredModel(models, defaultModel)
    const projects = this.collectProjects(allSessions)
    preferences.set("recentProjects", projects)

    return {
      connected: true,
      projects,
      sessions: sortSessions(sessions),
      archivedSessions: sortSessions(archivedSessions),
      models: normalizedModels,
      defaultModel,
    }
  }

  async chooseProject(webContents: WebContents): Promise<DesktopProjectDetails | null> {
    const owner = BrowserWindow.fromWebContents(webContents) ?? undefined
    const options: OpenDialogOptions = {
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory"],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    return await this.inspectProject(path)
  }

  async inspectProject(inputPath: string): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(inputPath)
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error("选择的项目路径不是目录。")

    const project = this.rememberProject(path)
    const client = await this.getClient()
    let branch: string | null = null
    try {
      branch = parseCurrentBranch(await client.getGitBranch({ cwd: path }))
    } catch {
      branch = null
    }

    return { project, branch }
  }

  async createSession(input: CreateDesktopSessionInput): Promise<SessionRecord> {
    const cwd = resolveRequiredPath(input.cwd)
    const model = requireString(input.model, "模型")
    const client = await this.getClient()
    const session = await client.createSession({ cwd, model, title: "" })
    this.rememberProject(cwd)
    return session
  }

  renameProject(input: RenameDesktopProjectInput): DesktopProject {
    const path = resolveRequiredPath(input.path)
    const name = requireString(input.name, "项目名称")
    this.updateProjectPreference(path, { name, hidden: false })
    return this.projectWithPreferences({
      name: basename(path),
      path,
      lastOpenedAt: this.projectLastOpenedAt(path),
    })
  }

  setProjectPinned(input: PinDesktopProjectInput): DesktopProject {
    const path = resolveRequiredPath(input.path)
    this.updateProjectPreference(path, { pinnedAt: input.pinned ? Date.now() : undefined })
    return this.projectWithPreferences({
      name: basename(path),
      path,
      lastOpenedAt: this.projectLastOpenedAt(path),
    })
  }

  removeProject(inputPath: string): void {
    const path = resolveRequiredPath(inputPath)
    this.updateProjectPreference(path, { hidden: true })
    preferences.set(
      "recentProjects",
      preferences
        .get("recentProjects")
        .filter((project) => projectKey(project.path) !== projectKey(path))
    )
  }

  async openSession(webContents: WebContents, sessionIdInput: string): Promise<DesktopSessionView> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    this.closeSession(webContents.id)

    const client = await this.getClient()
    const controller = new AbortController()
    const iterator = syncEvents(client, {
      sessionId,
      signal: controller.signal,
    })[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error("无法加载会话状态。")

    this.subscriptions.set(webContents.id, { controller, sessionId })
    webContents.once("destroyed", () => this.closeSession(webContents.id))
    setTimeout(() => {
      void this.pumpSession(webContents, sessionId, controller, iterator)
    }, 0)

    return toDesktopSessionView(first.value.state, sessionId, first.value.source)
  }

  closeSession(webContentsId: number): void {
    this.subscriptions.get(webContentsId)?.controller.abort()
    this.subscriptions.delete(webContentsId)
  }

  async sendPrompt(input: SendDesktopPromptInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const content = requireString(input.content, "消息内容")
    const client = await this.getClient()
    await client.admitPrompt(sessionId, { content, delivery: "queue" })
  }

  async interruptSession(sessionIdInput: string): Promise<void> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    const client = await this.getClient()
    await client.interruptSession(sessionId)
  }

  async replyPermission(input: ReplyDesktopPermissionInput): Promise<void> {
    const permissionId = requireString(input.permissionId, "权限请求 ID")
    const client = await this.getClient()
    await client.replyPermission(permissionId, {
      status: input.status,
      decision: input.decision ?? "once",
      clientId: "desktop",
    })
  }

  async renameSession(input: RenameDesktopSessionInput): Promise<SessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const title = requireString(input.title, "会话名称")
    const client = await this.getClient()
    return await client.updateSession(sessionId, { title })
  }

  async setSessionPinned(input: PinDesktopSessionInput): Promise<SessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const client = await this.getClient()
    const session = (await client.listSessions({ includeArchived: true, limit: 1_000 })).find(
      (item) => item.id === sessionId
    )
    if (!session) throw new Error(`会话 ${sessionId} 不存在。`)
    const desktop = readDesktopMetadata(session.metadata)
    if (input.pinned) desktop.pinnedAt = Date.now()
    else delete desktop.pinnedAt
    return await client.updateSession(sessionId, {
      metadata: { desktop, runtime: { model: session.model } },
    })
  }

  async archiveSession(webContentsId: number, sessionIdInput: string): Promise<SessionRecord> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    const subscription = this.subscriptions.get(webContentsId)
    if (subscription?.sessionId === sessionId) this.closeSession(webContentsId)
    const client = await this.getClient()
    return await client.archiveSession(sessionId)
  }

  async dispose(): Promise<void> {
    for (const subscription of this.subscriptions.values()) subscription.controller.abort()
    this.subscriptions.clear()

    const server = this.embeddedServer
    const embeddedUrl = this.embeddedUrl
    this.embeddedServer = null
    this.embeddedUrl = null
    this.clientPromise = null
    if (!server) return

    try {
      const registry = readDaemonRegistry()
      if (registry?.pid === process.pid && registry.url === embeddedUrl) clearDaemonRegistry()
    } catch {
      clearDaemonRegistry()
    }
    await server.close()
  }

  private async pumpSession(
    webContents: WebContents,
    sessionId: string,
    controller: AbortController,
    iterator: AsyncIterator<SyncEventUpdate>
  ): Promise<void> {
    try {
      while (!controller.signal.aborted && !webContents.isDestroyed()) {
        const update = await iterator.next()
        if (update.done) return
        const current = this.subscriptions.get(webContents.id)
        if (!current || current.controller !== controller || current.sessionId !== sessionId) return
        webContents.send(
          IpcEvents.sessionUpdated,
          toDesktopSessionView(update.value.state, sessionId, update.value.source)
        )
      }
    } catch (error) {
      if (!controller.signal.aborted && !webContents.isDestroyed()) {
        console.error(`[session] sync failed for ${sessionId}`, error)
      }
    }
  }

  private getClient(): Promise<OpenHarnessClient> {
    this.clientPromise ??= this.connect()
    return this.clientPromise
  }

  private async connect(): Promise<OpenHarnessClient> {
    try {
      const registry = readDaemonRegistry()
      if (registry) {
        const client = new OpenHarnessClient({ baseUrl: registry.url, token: registry.token })
        await healthWithTimeout(client)
        return client
      }
    } catch (error) {
      console.warn("[session] registered daemon is unavailable, starting embedded daemon", error)
      clearDaemonRegistry()
    }

    const token = createBearerToken()
    const { server, listen } = await startOpenHarnessDaemon({
      host: "127.0.0.1",
      port: 0,
      token,
      version: app.getVersion(),
    })
    this.embeddedServer = server
    this.embeddedUrl = listen.url
    writeDaemonRegistry({
      url: listen.url,
      pid: process.pid,
      token,
      storePath: server.store.path,
      startedAt: Date.now(),
      version: app.getVersion(),
    })
    return new OpenHarnessClient({ baseUrl: listen.url, token })
  }

  private collectProjects(sessions: SessionRecord[]): DesktopProject[] {
    const projects = new Map<string, DesktopProject>()
    for (const project of preferences.get("recentProjects")) {
      if (existsSync(project.path)) projects.set(projectKey(project.path), project)
    }
    for (const session of sessions) {
      if (!existsSync(session.cwd)) continue
      const key = projectKey(session.cwd)
      const existing = projects.get(key)
      projects.set(key, {
        name: basename(session.cwd),
        path: session.cwd,
        lastOpenedAt: Math.max(existing?.lastOpenedAt ?? 0, session.updatedAt),
      })
    }
    if (!app.isPackaged) {
      const rawDevPath = resolve(process.env["INIT_CWD"] ?? process.cwd())
      const devPath = findGitRoot(rawDevPath) ?? rawDevPath
      if (devPath !== rawDevPath) projects.delete(projectKey(rawDevPath))
      if (existsSync(devPath)) {
        const key = projectKey(devPath)
        projects.set(key, {
          name: basename(devPath),
          path: resolve(devPath),
          lastOpenedAt: projects.get(key)?.lastOpenedAt ?? Date.now(),
        })
      }
    }
    return [...projects.values()]
      .filter((project) => !this.projectPreference(project.path).hidden)
      .map((project) => this.projectWithPreferences(project))
      .sort(sortProjects)
  }

  private rememberProject(inputPath: string): DesktopProject {
    const path = resolve(inputPath)
    this.updateProjectPreference(path, { hidden: false })
    const project = this.projectWithPreferences({
      name: basename(path),
      path,
      lastOpenedAt: Date.now(),
    })
    const recent = preferences
      .get("recentProjects")
      .filter((item) => projectKey(item.path) !== projectKey(path))
    preferences.set("recentProjects", [project, ...recent].slice(0, 20))
    return project
  }

  private projectPreference(path: string): DesktopProjectPreference {
    return preferences.get("projectPreferences")[projectKey(path)] ?? {}
  }

  private updateProjectPreference(path: string, update: DesktopProjectPreference): void {
    const key = projectKey(path)
    const all = preferences.get("projectPreferences")
    const next = { ...all[key], ...update }
    for (const [field, value] of Object.entries(next)) {
      if (value === undefined) delete next[field as keyof DesktopProjectPreference]
    }
    preferences.set("projectPreferences", { ...all, [key]: next })
  }

  private projectWithPreferences(project: DesktopProject): DesktopProject {
    const preference = this.projectPreference(project.path)
    return {
      ...project,
      name: preference.name ?? project.name,
      ...(preference.pinnedAt ? { pinnedAt: preference.pinnedAt } : {}),
    }
  }

  private projectLastOpenedAt(path: string): number {
    return (
      preferences
        .get("recentProjects")
        .find((project) => projectKey(project.path) === projectKey(path))?.lastOpenedAt ??
      Date.now()
    )
  }
}

function sortProjects(left: DesktopProject, right: DesktopProject): number {
  return (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) || right.lastOpenedAt - left.lastOpenedAt
}

async function healthWithTimeout(client: OpenHarnessClient): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  try {
    await client.health({ signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function toDesktopSessionView(
  state: OpenHarnessClientState,
  sessionId: string,
  source: "snapshot" | "replay" | "live" | "reconnecting"
): DesktopSessionView {
  const bucket = state.buckets[sessionId]
  if (!bucket?.session) throw new Error(`会话 ${sessionId} 不存在。`)
  return {
    cursor: state.lastSeq,
    syncStatus: source === "reconnecting" ? "reconnecting" : "connected",
    session: bucket.session,
    inputs: [...bucket.inputs],
    messages: [...bucket.messages].sort((a, b) => a.seq - b.seq),
    parts: Object.values(bucket.partsByMessageId)
      .flat()
      .sort((a, b) => a.seq - b.seq),
    runs: Object.values(bucket.runs),
    tasks: Object.values(bucket.tasks),
    permissions: Object.values(bucket.permissions),
  }
}

function ensureConfiguredModel(models: DesktopModel[], configuredModel: string): DesktopModel[] {
  if (models.some((model) => model.id === configuredModel)) return models
  return [
    {
      id: configuredModel,
      label: configuredModel,
      provider: "configured",
      providerName: "Configured",
    },
    ...models,
  ]
}

function sortSessions(sessions: SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

function projectKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized
}

function findGitRoot(startPath: string): string | null {
  let current = resolve(startPath)
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function parseCurrentBranch(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  const labeled = trimmed.match(/^Current branch:\s*(.+)$/i)?.[1]?.trim()
  if (labeled) return labeled
  const starred = trimmed
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith("*"))
    ?.replace(/^\s*\*\s*/, "")
    .trim()
  return starred || trimmed.split(/\r?\n/)[0]?.trim() || null
}

function readDesktopMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const desktop = metadata["desktop"]
  return desktop && typeof desktop === "object" && !Array.isArray(desktop)
    ? { ...(desktop as Record<string, unknown>) }
    : {}
}

function resolveRequiredPath(value: unknown): string {
  return resolve(requireString(value, "项目路径"))
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

export const desktopSessionService = new DesktopSessionService()
