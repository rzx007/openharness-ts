/**
 * 桌面主进程的会话入口：连 daemon、attach 会话、把状态推给渲染进程。
 *
 * 打开一个会话不是拉 GET /events。syncEvents(sessionId) 会先 GET /sessions/:id/state
 * 拿当前消息快照，再接 GET /events/stream 跟后续增量。发消息走 admitPrompt，与 attach 无关。
 */
import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"

import {
  OpenHarnessClient,
  syncEvents,
  type OpenHarnessClientState,
  type ProjectRecord,
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

import { IpcEvents } from "../../../shared/ipc-channels"
import type {
  CheckoutDesktopProjectBranchInput,
  CloseDesktopAuxSessionInput,
  CreateDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  DesktopBootstrapData,
  DesktopAuxSessionUpdate,
  DesktopModel,
  DesktopProject,
  DesktopProjectDetails,
  DesktopPermissionMode,
  DesktopSessionView,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
  OpenDesktopAuxSessionInput,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SetDefaultDesktopProjectShellInput,
  SendDesktopPromptInput,
  SetDefaultDesktopModelInput,
  SetDefaultDesktopPermissionModeInput,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
} from "../../../shared/session-types"
import { reserveSubscriptionSnapshot, SessionSubscriptionRegistry } from "./session-subscriptions"

const execFileAsync = promisify(execFile)

const primarySubscriptionSlot = "primary"

class DesktopSessionService {
  private clientPromise: Promise<OpenHarnessClient> | null = null
  private embeddedServer: OpenHarnessHttpServer | null = null
  private embeddedUrl: string | null = null
  private readonly subscriptions = new SessionSubscriptionRegistry()

  async bootstrap(): Promise<DesktopBootstrapData> {
    const client = await this.getClient()
    const [settings, providers, allSessions, projectRecords] = await Promise.all([
      client.getSettings(),
      client.listModels(),
      client.listSessions({ includeArchived: true, limit: 400 }),
      client.listProjects(),
    ])
    const sessions = allSessions.filter((session) => session.status !== "archived")
    const archivedSessions = allSessions.filter((session) => session.status === "archived")
    const models = providers.flatMap((provider) => provider.models)
    const storedConfiguredModel =
      typeof settings["model"] === "string" ? settings["model"] : undefined
    const configuredProvider = optionalProvider(settings["provider"])
    const configuredModel = storedConfiguredModel
    const defaultModel = configuredModel ?? models[0]?.id
    const defaultPermissionMode = readSettingsPermissionMode(settings)

    if (!defaultModel) {
      throw new Error("没有找到可用模型，请先在 OpenHarness 设置中配置模型。")
    }

    const normalizedModels = ensureConfiguredModel(models, defaultModel)
    const defaultProvider = resolveDefaultProvider(
      normalizedModels,
      defaultModel,
      configuredProvider
    )
    if (
      defaultModel !== storedConfiguredModel ||
      (defaultProvider && defaultProvider !== configuredProvider)
    ) {
      await client.patchSettings({
        model: defaultModel,
        ...(defaultProvider ? { provider: defaultProvider } : {}),
      })
    }
    const projects = await Promise.all(projectRecords.map(toDesktopProject))

    return {
      connected: true,
      projects,
      sessions: sortSessions(sessions),
      archivedSessions: sortSessions(archivedSessions),
      models: normalizedModels,
      defaultModel,
      ...(defaultProvider ? { defaultProvider } : {}),
      defaultPermissionMode,
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

    const client = await this.getClient()
    const project = await toDesktopProject(await client.inspectProject(path))
    let git = false
    let branch: string | null = null
    let branches: string[] = []
    try {
      await execGit(path, ["rev-parse", "--is-inside-work-tree"])
      git = true
      try {
        branch = parseCurrentBranch(await client.getGitBranch({ cwd: path }))
      } catch {
        branch = null
      }
      try {
        branches = await listLocalBranches(path)
      } catch {
        branches = []
      }
    } catch {
      git = false
      branch = null
      branches = []
    }

    return { project, git, branch, branches }
  }

  async checkoutProjectBranch(
    input: CheckoutDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(input.path)
    const branch = requireGitBranchName(input.branch)
    await execGit(path, ["switch", branch])
    return await this.inspectProject(path)
  }

  async createProjectBranch(
    input: CreateDesktopProjectBranchInput
  ): Promise<DesktopProjectDetails> {
    const path = resolveRequiredPath(input.path)
    const branch = requireGitBranchName(input.branch)
    await execGit(path, ["check-ref-format", "--branch", branch])
    await execGit(path, ["switch", "-c", branch])
    return await this.inspectProject(path)
  }

  async createSession(input: CreateDesktopSessionInput): Promise<SessionRecord> {
    const cwd = resolveRequiredPath(input.cwd)
    const model = requireString(input.model, "模型")
    const permissionMode = normalizePermissionMode(input.permissionMode)
    const client = await this.getClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    const projectId = requireString(input.projectId, "Project ID")
    const session = await client.createSession({
      projectId,
      cwd,
      model,
      title: "",
      metadata: {
        runtime: {
          model,
          ...(provider ? { provider } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        },
      },
    })
    return session
  }

  async renameProject(input: RenameDesktopProjectInput): Promise<DesktopProject> {
    const name = requireString(input.name, "项目名称")
    return await toDesktopProject(
      await (await this.getClient()).renameProject(input.projectId, name)
    )
  }

  async setProjectPinned(input: PinDesktopProjectInput): Promise<DesktopProject> {
    return await toDesktopProject(
      await (await this.getClient()).setProjectPinned(input.projectId, input.pinned)
    )
  }

  async setProjectDefaultShell(input: SetDefaultDesktopProjectShellInput): Promise<DesktopProject> {
    return await toDesktopProject(
      await (await this.getClient()).setProjectDefaultShell(input.projectId, input.shell)
    )
  }

  async removeProject(projectId: string): Promise<void> {
    await (await this.getClient()).archiveProject(requireString(projectId, "Project ID"))
  }

  async resolveProjectDirectory(projectIdInput: string): Promise<string> {
    const projectId = requireString(projectIdInput, "Project ID")
    const client = await this.getClient()
    const project = (await client.listProjects()).find((item) => item.id === projectId)
    if (!project) throw new Error(`Project ${projectId} does not exist.`)

    const info = await stat(project.path)
    if (!info.isDirectory()) throw new Error(`Project ${project.name} directory is unavailable.`)
    return project.path
  }

  async rebindProject(
    webContents: WebContents,
    projectIdInput: string
  ): Promise<DesktopProject | null> {
    const owner = BrowserWindow.fromWebContents(webContents) ?? undefined
    const options: OpenDialogOptions = {
      title: "重新绑定项目目录",
      properties: ["openDirectory"],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const project = await (
      await this.getClient()
    ).rebindProject(requireString(projectIdInput, "Project ID"), path)
    return await toDesktopProject(project)
  }

  /**
   * 挂上指定会话：先等 snapshot（历史消息），立刻返回给窗口；SSE 增量放到 pumpSession 后台推。
   * 每个窗口只有一条 primary 订阅，再 open 会关掉上一条。
   */
  async openSession(webContents: WebContents, sessionIdInput: string): Promise<DesktopSessionView> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    this.closeSession(webContents.id)

    const controller = new AbortController()
    const subscription = { controller, sessionId }
    webContents.once("destroyed", () => this.closeSession(webContents.id))
    const { snapshot, iterator } = await reserveSubscriptionSnapshot(
      this.subscriptions,
      webContents.id,
      primarySubscriptionSlot,
      subscription,
      async () => {
        const client = await this.getClient()
        return syncEvents(client, {
          sessionId,
          signal: controller.signal,
        })[Symbol.asyncIterator]()
      },
      "无法加载会话状态。"
    )
    // 等本次 IPC 返回快照后再泵 live，避免第一帧和后续更新抢道。
    setTimeout(() => {
      void this.pumpSession(webContents, primarySubscriptionSlot, sessionId, controller, iterator)
    }, 0)

    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
  }

  closeSession(webContentsId: number): void {
    this.subscriptions.clearOwner(webContentsId)
  }

  /** 同一窗口上额外挂一个会话（对比/子会话），订阅槽是 aux:{id}，不挤掉 primary。 */
  async openAuxSession(
    webContents: WebContents,
    input: OpenDesktopAuxSessionInput
  ): Promise<DesktopSessionView> {
    const subscriptionId = requireString(input.subscriptionId, "辅助订阅 ID")
    const sessionId = requireString(input.sessionId, "会话 ID")
    const slot = auxiliarySubscriptionSlot(subscriptionId)
    const controller = new AbortController()
    const subscription = { controller, sessionId }
    const { snapshot, iterator } = await reserveSubscriptionSnapshot(
      this.subscriptions,
      webContents.id,
      slot,
      subscription,
      async () => {
        const client = await this.getClient()
        return syncEvents(client, {
          sessionId,
          signal: controller.signal,
        })[Symbol.asyncIterator]()
      },
      "无法加载辅助会话状态。"
    )
    setTimeout(() => {
      void this.pumpSession(webContents, slot, sessionId, controller, iterator, subscriptionId)
    }, 0)
    return toDesktopSessionView(snapshot.state, sessionId, snapshot.source)
  }

  closeAuxSession(webContentsId: number, input: CloseDesktopAuxSessionInput): void {
    const subscriptionId = requireString(input.subscriptionId, "辅助订阅 ID")
    this.subscriptions.delete(webContentsId, auxiliarySubscriptionSlot(subscriptionId))
  }

  /** 往已 attach 的会话排队一句用户输入。结果仍从刚才那条 SSE 订阅回来。 */
  async sendPrompt(input: SendDesktopPromptInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const content = requireString(input.content, "消息内容")
    const client = await this.getClient()
    await client.admitPrompt(sessionId, { content, delivery: "queue" })
  }

  async editLatestPrompt(input: EditLatestDesktopPromptInput): Promise<void> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const content = requireString(input.content, "消息内容")
    const client = await this.getClient()
    await client.editLatestPrompt(sessionId, { content })
  }

  async forkSession(input: ForkDesktopSessionInput): Promise<SessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const client = await this.getClient()
    return await client.forkSession(sessionId, {
      ...(input.beforeMessageId ? { beforeMessageId: input.beforeMessageId } : {}),
      ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
    })
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

  async setDefaultModel(input: SetDefaultDesktopModelInput): Promise<DesktopBootstrapData> {
    const model = requireString(input.model, "模型")
    const client = await this.getClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    await client.patchSettings({
      model,
      ...(provider ? { provider } : {}),
    })
    return await this.bootstrap()
  }

  async setDefaultPermissionMode(
    input: SetDefaultDesktopPermissionModeInput
  ): Promise<DesktopBootstrapData> {
    const permissionMode = requirePermissionMode(input.permissionMode)
    const client = await this.getClient()
    const settings = await client.getSettings()
    const permission = settings["permission"]
    await client.patchSettings({
      permission: {
        ...(permission && typeof permission === "object" && !Array.isArray(permission)
          ? permission
          : {}),
        mode: permissionMode,
      },
    })
    return await this.bootstrap()
  }

  async updateSessionModel(input: UpdateDesktopSessionModelInput): Promise<SessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const model = requireString(input.model, "模型")
    const client = await this.getClient()
    const provider = await resolveProviderForModel(client, model, input.provider)
    return await client.updateSession(sessionId, {
      metadata: {
        runtime: {
          model,
          ...(provider ? { provider } : {}),
        },
      },
    })
  }

  async updateSessionPermissionMode(
    input: UpdateDesktopSessionPermissionModeInput
  ): Promise<SessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const permissionMode = requirePermissionMode(input.permissionMode)
    return await (
      await this.getClient()
    ).updateSession(sessionId, {
      metadata: { runtime: { permissionMode } },
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
    const subscription = this.subscriptions.get(webContentsId, primarySubscriptionSlot)
    if (subscription?.sessionId === sessionId) this.closeSession(webContentsId)
    const client = await this.getClient()
    return await client.archiveSession(sessionId)
  }

  async deleteSession(webContentsId: number, sessionIdInput: string): Promise<string[]> {
    const sessionId = requireString(sessionIdInput, "会话 ID")
    const subscription = this.subscriptions.get(webContentsId, primarySubscriptionSlot)
    if (subscription?.sessionId === sessionId) this.closeSession(webContentsId)
    const client = await this.getClient()
    return await client.deleteSession(sessionId)
  }

  async dispose(): Promise<void> {
    this.subscriptions.clearAll()

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

  daemonClient(): Promise<OpenHarnessClient> {
    return this.getClient()
  }

  refreshDaemonClient(): Promise<OpenHarnessClient> {
    this.clientPromise = null
    return this.getClient()
  }

  private async pumpSession(
    webContents: WebContents,
    slot: string,
    sessionId: string,
    controller: AbortController,
    iterator: AsyncIterator<SyncEventUpdate>,
    auxiliarySubscriptionId?: string
  ): Promise<void> {
    try {
      while (!controller.signal.aborted && !webContents.isDestroyed()) {
        const update = await iterator.next()
        if (update.done) return
        const current = this.subscriptions.get(webContents.id, slot)
        if (!current || current.controller !== controller || current.sessionId !== sessionId) return
        const view = toDesktopSessionView(update.value.state, sessionId, update.value.source)
        if (auxiliarySubscriptionId) {
          const payload: DesktopAuxSessionUpdate = {
            subscriptionId: auxiliarySubscriptionId,
            view,
          }
          webContents.send(IpcEvents.sessionAuxUpdated, payload)
        } else {
          webContents.send(IpcEvents.sessionUpdated, view)
        }
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
        await verifyDaemonWithTimeout(client)
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
}

function auxiliarySubscriptionSlot(subscriptionId: string): string {
  return `aux:${subscriptionId}`
}

async function toDesktopProject(project: ProjectRecord): Promise<DesktopProject> {
  let available = false
  try {
    available = (await stat(project.path)).isDirectory()
  } catch {
    available = false
  }
  return { ...project, available }
}

async function verifyDaemonWithTimeout(client: OpenHarnessClient): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  try {
    await client.health({ signal: controller.signal })
    await client.listProjects({ signal: controller.signal })
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

async function listLocalBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execGit(cwd, ["branch", "--format=%(refname:short)"])
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, windowsHide: true })
    return { stdout, stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Git operation failed: ${message}`)
  }
}

function requireGitBranchName(value: unknown): string {
  const branch = requireString(value, "分支名称")
  if (branch.startsWith("-")) throw new Error("分支名称不能以 - 开头。")
  if (/[\u0000-\u001f\u007f]/.test(branch)) throw new Error("分支名称不能包含控制字符。")
  return branch
}

function readDesktopMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const desktop = metadata["desktop"]
  return desktop && typeof desktop === "object" && !Array.isArray(desktop)
    ? { ...(desktop as Record<string, unknown>) }
    : {}
}

function readSettingsPermissionMode(settings: Record<string, unknown>): DesktopPermissionMode {
  const permission = settings["permission"]
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return "default"
  return normalizePermissionMode((permission as Record<string, unknown>)["mode"]) ?? "default"
}

function normalizePermissionMode(value: unknown): DesktopPermissionMode | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined
}

function requirePermissionMode(value: unknown): DesktopPermissionMode {
  const mode = normalizePermissionMode(value)
  if (!mode) throw new Error("权限模式必须是 default、plan 或 full_auto。")
  return mode
}

function optionalProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const provider = value.trim()
  if (!provider || provider.toLowerCase() === "configured") return undefined
  return provider
}

function resolveDefaultProvider(
  models: DesktopModel[],
  model: string,
  configuredProvider: string | undefined
): string | undefined {
  if (
    configuredProvider &&
    models.some((item) => item.id === model && item.providerName === configuredProvider)
  ) {
    return configuredProvider
  }
  const providers = uniqueModelProviders(models, model)
  return providers.length === 1 ? providers[0] : configuredProvider
}

async function resolveProviderForModel(
  client: OpenHarnessClient,
  model: string,
  requestedProvider: unknown
): Promise<string | undefined> {
  const provider = optionalProvider(requestedProvider)
  const models = (await client.listModels()).flatMap((item) => item.models)
  if (provider) {
    if (!models.some((item) => item.id === model && item.providerName === provider)) {
      throw new Error(`模型 ${model} 不属于 provider ${provider}。`)
    }
    return provider
  }

  const providers = uniqueModelProviders(models, model)
  if (providers.length <= 1) return providers[0]

  const settings = await client.getSettings()
  const configuredProvider = optionalProvider(settings["provider"])
  if (configuredProvider && providers.includes(configuredProvider)) return configuredProvider
  throw new Error(`模型 ${model} 在多个 provider 中同名，请明确指定 provider。`)
}

function uniqueModelProviders(models: DesktopModel[], model: string): string[] {
  return [
    ...new Set(
      models
        .filter((item) => item.id === model)
        .map((item) => optionalProvider(item.providerName))
        .filter((item): item is string => Boolean(item))
    ),
  ]
}

function resolveRequiredPath(value: unknown): string {
  return resolve(requireString(value, "项目路径"))
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}

export const desktopSessionService = new DesktopSessionService()
