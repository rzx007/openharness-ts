import {
  AlertCircle,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  CircleStop,
  FileText,
  Folder,
  FolderClosed,
  FolderGit2,
  GitBranch,
  ListFilter,
  LoaderCircle,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelRight,
  Plus,
  Search,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { AssistantMessage } from "@renderer/components/desktop/conversation/assistant-message"
import { buildConversationEntries } from "@renderer/components/desktop/conversation/conversation-turn-model"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import type {
  DesktopModel,
  DesktopPermissionMode,
  DesktopPermissionRequest,
  DesktopProject,
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

type ConversationPaneProps = {
  panelOpen: boolean
  onTogglePanel: () => void
  onOpenFile: (path: string, line?: number) => void
  onOpenTerminal: (terminalId: string) => void
}

interface AddToComposerEventDetail {
  text: string
}

export function ConversationPane({
  panelOpen,
  onTogglePanel,
  onOpenFile,
  onOpenTerminal,
}: ConversationPaneProps): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const openingSession = useDesktopSessionStore((state) => state.openingSession)
  const sending = useDesktopSessionStore((state) => state.sending)
  const error = useDesktopSessionStore((state) => state.error)
  const models = useDesktopSessionStore((state) => state.models)
  const selectedModel = useDesktopSessionStore((state) => state.selectedModel)
  const selectedProvider = useDesktopSessionStore((state) => state.selectedProvider)
  const selectedPermissionMode = useDesktopSessionStore((state) => state.selectedPermissionMode)
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const branch = useDesktopSessionStore((state) => state.branch)
  const projects = useDesktopSessionStore((state) => state.projects)
  const loadStatus = useDesktopSessionStore((state) => state.loadStatus)
  const startSession = useDesktopSessionStore((state) => state.startSession)
  const sendMessage = useDesktopSessionStore((state) => state.sendMessage)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const selectModel = useDesktopSessionStore((state) => state.selectModel)
  const selectPermissionMode = useDesktopSessionStore((state) => state.selectPermissionMode)
  const updateSessionModel = useDesktopSessionStore((state) => state.updateSessionModel)
  const updateSessionPermissionMode = useDesktopSessionStore(
    (state) => state.updateSessionPermissionMode
  )
  const interrupt = useDesktopSessionStore((state) => state.interrupt)
  const replyPermission = useDesktopSessionStore((state) => state.replyPermission)
  const clearError = useDesktopSessionStore((state) => state.clearError)
  const endRef = useRef<HTMLDivElement>(null)
  const hasSession = activeSessionId !== null
  const archived = sessionView?.session.status === "archived"

  useEffect(() => {
    if (!hasSession || !sessionView) return
    endRef.current?.scrollIntoView({ block: "end" })
  }, [hasSession, sessionView?.cursor, sessionView])

  const submitDraft = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || sending || archived) return
    try {
      if (hasSession) await sendMessage(content)
      else await startSession(content)
      setDraft("")
    } catch {
      // The store keeps the error and the draft stays available for retry.
    }
  }

  const title = sessionView?.session.title.trim() || "新对话"
  const currentModel = sessionView?.session.model ?? selectedModel
  const modelLabel = resolveModelLabel(models, currentModel, selectedProvider)
  const running = Boolean(
    sessionView?.runs.some((run) => run.status === "pending" || run.status === "running") ||
    sessionView?.session.status === "running"
  )
  const pendingPermissions =
    sessionView?.permissions.filter((permission) => permission.status === "pending") ?? []

  useEffect(() => {
    const handleAddToComposer = (event: Event): void => {
      const detail = (event as CustomEvent<AddToComposerEventDetail>).detail
      if (!detail?.text) return
      setDraft((current) => appendDraftText(current, detail.text))
      window.requestAnimationFrame(() => {
        const composer = document.querySelector<HTMLTextAreaElement>(
          "#message-composer, #new-conversation-composer"
        )
        composer?.focus()
      })
    }

    window.addEventListener("desktop:add-to-composer", handleAddToComposer)
    return () => window.removeEventListener("desktop:add-to-composer", handleAddToComposer)
  }, [])

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-conversation">
      {hasSession ? (
        <header className="flex h-12 shrink-0 items-center border-b bg-background px-3">
          <div className="flex min-w-0 items-center gap-2">
            <FolderClosed className="size-4 shrink-0 text-ui-muted" strokeWidth={1.8} />
            <h1 className="truncate text-[13px] font-semibold">{title}</h1>
            {sessionView?.syncStatus === "reconnecting" ? (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-ui-muted">
                <LoaderCircle className="size-3 animate-spin" />
                正在重连
              </span>
            ) : null}
            <button
              type="button"
              title="更多操作"
              aria-label="更多操作"
              className="grid size-7 shrink-0 place-items-center rounded-md text-ui-muted hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
            >
              <MoreHorizontal />
            </button>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              title={sessionView?.session.cwd}
              className="flex h-8 items-center gap-2 rounded-lg border bg-background px-2.5 text-xs text-ui-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <FolderGit2 className="size-3.5 text-amber-500" />
              <span className="hidden max-w-32 truncate sm:inline">
                {projectName(sessionView?.session.cwd)}
              </span>
            </button>
            <HeaderIconButton label="会话视图">
              <ListFilter />
            </HeaderIconButton>
            {!panelOpen && (
              <HeaderIconButton label="展开工具面板" onClick={onTogglePanel}>
                <PanelRight />
              </HeaderIconButton>
            )}
          </div>
        </header>
      ) : null}

      {error ? <ErrorBanner message={error} onClose={clearError} /> : null}

      {!hasSession ? (
        <NewConversationStart
          draft={draft}
          sending={sending}
          loadStatus={loadStatus}
          projects={projects}
          selectedProject={selectedProject}
          branch={branch}
          models={models}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedPermissionMode={selectedPermissionMode}
          panelOpen={panelOpen}
          onDraftChange={setDraft}
          onSubmit={() => void submitDraft()}
          onChooseProject={() => void chooseProject()}
          onSelectProject={(project) => void selectProject(project)}
          onSelectModel={(model) => void selectModel(model)}
          onSelectPermissionMode={(permissionMode) => void selectPermissionMode(permissionMode)}
          onTogglePanel={onTogglePanel}
        />
      ) : (
        <>
          <ScrollArea
            horizontal={false}
            className="min-h-0 min-w-0 flex-1"
            viewportClassName="overflow-x-hidden"
            contentClassName="w-full max-w-full"
          >
            <article className="mx-auto flex min-h-full w-full max-w-190 min-w-0 flex-col px-6 pt-7 pb-5">
              {openingSession && !sessionView ? (
                <div className="flex flex-1 items-center justify-center text-sm text-ui-muted">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  正在加载会话
                </div>
              ) : (
                <ConversationTranscript
                  messages={sessionView?.messages ?? []}
                  parts={sessionView?.parts ?? []}
                  runs={sessionView?.runs ?? []}
                  running={running}
                  onOpenFile={onOpenFile}
                  onOpenTerminal={onOpenTerminal}
                />
              )}

              {pendingPermissions.map((permission) => (
                <PermissionCard
                  key={permission.id}
                  permission={permission}
                  onReply={(status, decision) =>
                    void replyPermission(permission.id, status, decision)
                  }
                />
              ))}
              <div ref={endRef} />
            </article>
          </ScrollArea>

          {archived ? (
            <div className="mx-auto mb-5 flex h-12 w-[min(760px,calc(100%-32px))] shrink-0 items-center justify-center rounded-lg border border-border bg-background/90 text-xs text-muted-foreground shadow-sm">
              此会话已归档，只能查看历史内容
            </div>
          ) : (
            <Composer
              id="message-composer"
              draft={draft}
              sending={sending}
              running={running}
              models={models}
              selectedModel={currentModel}
              selectedProvider={selectedProvider}
              modelLabel={modelLabel}
              permissionMode={selectedPermissionMode}
              onDraftChange={setDraft}
              onSubmit={() => void submitDraft()}
              onInterrupt={() => void interrupt()}
              onSelectModel={(model) => {
                if (activeSessionId) void updateSessionModel(activeSessionId, model)
              }}
              onSelectPermissionMode={(permissionMode) => {
                if (activeSessionId)
                  void updateSessionPermissionMode(activeSessionId, permissionMode)
              }}
            />
          )}
        </>
      )}
    </section>
  )
}

function ConversationTranscript({
  messages,
  parts,
  runs,
  running,
  onOpenFile,
  onOpenTerminal,
}: {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  running: boolean
  onOpenFile: (path: string, line?: number) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const entries = useMemo(
    () => buildConversationEntries(messages, parts, runs),
    [messages, parts, runs]
  )
  const lastTurn = [...entries].reverse().find((entry) => entry.type === "turn")
  const failedRuns = runs.filter((run) => run.status === "failed")
  const attachedRunIds = new Set(
    entries.flatMap((entry) => {
      if (entry.type !== "turn") return []
      return failedRuns
        .filter(
          (run) =>
            entry.turn.runIds.includes(run.id) ||
            (Boolean(run.inputId) && run.inputId === entry.turn.inputId)
        )
        .map((run) => run.id)
    })
  )
  const unattachedFailures = failedRuns.filter((run) => !attachedRunIds.has(run.id))

  if (messages.length === 0 && !running && failedRuns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ui-muted">
        这个会话还没有消息
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-8 text-[15px] leading-7 text-content-foreground">
      {entries.map((entry) => {
        if (entry.type === "system") {
          return (
            <MessageBlock
              key={entry.system.id}
              message={entry.system.message}
              parts={entry.system.parts}
              streaming={false}
              onOpenFile={onOpenFile}
              onOpenTerminal={onOpenTerminal}
            />
          )
        }
        const turnFailures = failedRuns.filter(
          (run) =>
            entry.turn.runIds.includes(run.id) ||
            (Boolean(run.inputId) && run.inputId === entry.turn.inputId)
        )
        return (
          <section key={entry.turn.id} className="min-w-0 space-y-8">
            {entry.turn.userMessage ? (
              <MessageBlock
                message={entry.turn.userMessage}
                parts={entry.turn.userParts}
                streaming={false}
                onOpenFile={onOpenFile}
                onOpenTerminal={onOpenTerminal}
              />
            ) : null}
            {entry.turn.assistantMessages.length > 0 ? (
              <AssistantMessage
                parts={entry.turn.assistantParts}
                streaming={running && entry === lastTurn}
                onOpenFile={onOpenFile}
                onOpenTerminal={onOpenTerminal}
              />
            ) : null}
            {turnFailures.map((run) => (
              <RunErrorNotice key={run.id} error={run.error} />
            ))}
          </section>
        )
      })}
      {unattachedFailures.map((run) => (
        <RunErrorNotice key={run.id} error={run.error} />
      ))}
      {running ? (
        <div className="flex items-center gap-2 text-xs text-ui-muted">
          <LoaderCircle className="size-3.5 animate-spin" />
          OpenHarness 正在处理
        </div>
      ) : null}
    </div>
  )
}

function RunErrorNotice({ error }: { error?: string }): React.JSX.Element {
  const detail = error?.trim() || "运行失败，但服务端没有返回具体原因。"
  const guidance = runFailureGuidance(detail)
  return (
    <section
      role="alert"
      className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-destructive">请求失败</h3>
          {guidance ? <p className="mt-1 text-xs leading-5 text-foreground">{guidance}</p> : null}
          <p className="mt-1.5 text-xs leading-5 break-words whitespace-pre-wrap text-ui-muted">
            {detail}
          </p>
        </div>
      </div>
    </section>
  )
}

function runFailureGuidance(error: string): string | null {
  if (
    error.includes("not supported when using Codex") ||
    error.includes("supported API model names")
  ) {
    return "当前模型与供应商不匹配，请在输入框右下角重新选择模型。"
  }
  return null
}

function MessageBlock({
  message,
  parts,
  streaming,
  onOpenFile,
  onOpenTerminal,
}: {
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
  streaming: boolean
  onOpenFile: (path: string, line?: number) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  if (message.role === "user") {
    const content = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-xl bg-user-message px-4 py-3 text-[13px] leading-6 whitespace-pre-wrap text-foreground">
          {content || "已发送消息"}
        </div>
      </div>
    )
  }

  if (message.role === "system") {
    const content = parts.map((part) => part.text ?? "").join("")
    return <p className="text-xs whitespace-pre-wrap text-ui-muted">{content}</p>
  }

  return (
    <AssistantMessage
      parts={parts}
      streaming={streaming}
      onOpenFile={onOpenFile}
      onOpenTerminal={onOpenTerminal}
    />
  )
}

function PermissionCard({
  permission,
  onReply,
}: {
  permission: DesktopPermissionRequest
  onReply: (status: "approved" | "denied", decision?: "once" | "session") => void
}): React.JSX.Element {
  return (
    <section className="mt-6 rounded-xl border bg-background px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ui-muted">
          <ShieldCheck className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-foreground">需要你的批准</h3>
          <p className="mt-1 text-xs text-ui-muted">OpenHarness 请求运行 {permission.toolName}</p>
        </div>
        <button
          type="button"
          onClick={() => onReply("denied")}
          className="h-8 rounded-md px-3 text-xs text-ui-muted hover:bg-muted hover:text-foreground"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={() => onReply("approved", "once")}
          className="h-8 rounded-lg border px-3 text-xs font-medium text-foreground hover:bg-muted"
        >
          允许
        </button>
      </div>
    </section>
  )
}

type StartPicker = "project" | "runtime" | "branch" | "model" | "permission"

function NewConversationStart({
  draft,
  sending,
  loadStatus,
  projects,
  selectedProject,
  branch,
  models,
  selectedModel,
  selectedProvider,
  selectedPermissionMode,
  panelOpen,
  onDraftChange,
  onSubmit,
  onChooseProject,
  onSelectProject,
  onSelectModel,
  onSelectPermissionMode,
  onTogglePanel,
}: {
  draft: string
  sending: boolean
  loadStatus: "idle" | "loading" | "ready" | "error"
  projects: DesktopProject[]
  selectedProject: DesktopProject | null
  branch: string | null
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  selectedPermissionMode: DesktopPermissionMode
  panelOpen: boolean
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onChooseProject: () => void
  onSelectProject: (project: DesktopProject) => void
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
  onTogglePanel: () => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<StartPicker | null>(null)
  const [projectQuery, setProjectQuery] = useState("")
  const pickerAreaRef = useRef<HTMLDivElement>(null)
  const visibleProjects = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())
  )
  const modelLabel = resolveModelLabel(models, selectedModel, selectedProvider)
  const permissionLabel = resolvePermissionModeLabel(selectedPermissionMode)

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (pickerAreaRef.current?.contains(event.target as Node)) return
      setActivePicker(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActivePicker(null)
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer)
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [])

  const togglePicker = (picker: StartPicker): void => {
    setActivePicker((current) => (current === picker ? null : picker))
  }

  return (
    <div className="relative min-h-0 flex-1 px-5 py-5">
      {selectedProject && !panelOpen ? (
        <div className="absolute top-4 right-4">
          <HeaderIconButton label="展开工具面板" onClick={onTogglePanel}>
            <PanelRight />
          </HeaderIconButton>
        </div>
      ) : null}
      <div className="mx-auto flex h-full w-full max-w-[760px] flex-col items-center justify-center pb-[5vh]">
        <div className="mb-7 flex flex-col items-center text-center">
          <Workflow
            aria-hidden="true"
            className="mb-5 size-9 text-ui-muted/65"
            strokeWidth={1.45}
          />
          <h2 className="text-[26px] leading-9 font-medium text-foreground">
            {selectedProject ? (
              <>
                要在{" "}
                <span className="underline decoration-foreground/25 underline-offset-4">
                  {selectedProject.name}
                </span>{" "}
                中构建什么？
              </>
            ) : (
              "今天想构建什么？"
            )}
          </h2>
        </div>

        <div ref={pickerAreaRef} className="relative w-full">
          <div className="mx-3 flex h-12 min-w-0 items-start gap-0.5 rounded-t-2xl bg-muted/70 px-2.5 pt-2">
            <div className="relative min-w-0">
              <StartPickerButton
                label={
                  loadStatus === "loading" ? "加载项目..." : (selectedProject?.name ?? "选择项目")
                }
                expanded={activePicker === "project"}
                onClick={() => togglePicker("project")}
              >
                <Folder />
              </StartPickerButton>

              {activePicker === "project" ? (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-50 mb-2 w-[290px] rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10"
                >
                  <label className="flex h-9 items-center gap-2 px-2 text-ui-muted">
                    <Search className="size-3.5 shrink-0" />
                    <span className="sr-only">搜索项目</span>
                    <input
                      autoFocus
                      value={projectQuery}
                      placeholder="搜索项目"
                      onChange={(event) => setProjectQuery(event.target.value)}
                      className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-placeholder"
                    />
                  </label>
                  <div className="max-h-44 overflow-y-auto py-0.5">
                    {visibleProjects.map((project) => (
                      <PickerMenuItem
                        key={project.path}
                        selected={project.path === selectedProject?.path}
                        onClick={() => {
                          onSelectProject(project)
                          setProjectQuery("")
                          setActivePicker(null)
                        }}
                      >
                        <Folder />
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      </PickerMenuItem>
                    ))}
                    {visibleProjects.length === 0 ? (
                      <p className="px-2 py-5 text-center text-xs text-ui-muted">没有匹配的项目</p>
                    ) : null}
                  </div>
                  <div className="mt-1 border-t pt-1">
                    <PickerMenuItem
                      onClick={() => {
                        onChooseProject()
                        setActivePicker(null)
                      }}
                    >
                      <Plus />
                      <span>选择其他文件夹</span>
                    </PickerMenuItem>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="relative shrink-0">
              <StartPickerButton
                label="本地"
                expanded={activePicker === "runtime"}
                onClick={() => togglePicker("runtime")}
              >
                <Monitor />
              </StartPickerButton>
              {activePicker === "runtime" ? (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-50 mb-2 w-44 rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10"
                >
                  <PickerMenuItem selected onClick={() => setActivePicker(null)}>
                    <Monitor />
                    <span>本地</span>
                  </PickerMenuItem>
                  <button
                    type="button"
                    disabled
                    title="沙箱模式将在后续版本接入"
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-ui-muted opacity-45 [&_svg]:size-3.5"
                  >
                    <Box />
                    <span>沙箱</span>
                    <span className="ml-auto text-[10px]">即将支持</span>
                  </button>
                </div>
              ) : null}
            </div>

            <div className="relative min-w-0">
              <StartPickerButton
                label={branch ?? "非 Git 项目"}
                expanded={activePicker === "branch"}
                onClick={() => togglePicker("branch")}
              >
                <GitBranch />
              </StartPickerButton>
              {activePicker === "branch" ? (
                <div className="absolute bottom-full left-0 z-50 mb-2 w-52 rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10">
                  <PickerMenuItem selected onClick={() => setActivePicker(null)}>
                    <GitBranch />
                    <span className="min-w-0 flex-1 truncate">{branch ?? "非 Git 项目"}</span>
                  </PickerMenuItem>
                </div>
              ) : null}
            </div>
          </div>

          <form
            className="relative -mt-2 rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12"
            onSubmit={(event) => {
              event.preventDefault()
              onSubmit()
            }}
          >
            <label htmlFor="new-conversation-composer" className="sr-only">
              输入新对话内容
            </label>
            <textarea
              id="new-conversation-composer"
              value={draft}
              rows={3}
              placeholder="随心输入"
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  onSubmit()
                }
              }}
              className="block max-h-48 min-h-24 w-full resize-none bg-transparent px-4 pt-4 text-[13px] leading-6 text-foreground outline-none placeholder:text-placeholder"
            />

            <div className="flex h-12 items-center gap-1 px-3 pb-2">
              <ComposerIconButton label="添加附件">
                <Plus />
              </ComposerIconButton>
              <div className="relative ml-1">
                <button
                  type="button"
                  aria-expanded={activePicker === "permission"}
                  onClick={() => togglePicker("permission")}
                  className="flex h-8 max-w-36 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <ShieldCheck className="size-3.5 shrink-0" />
                  <span className="truncate">{permissionLabel}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
                {activePicker === "permission" ? (
                  <PermissionModeMenu
                    selected={selectedPermissionMode}
                    onSelect={(permissionMode) => {
                      onSelectPermissionMode(permissionMode)
                      setActivePicker(null)
                    }}
                    className="absolute bottom-full left-0 z-50 mb-2 w-64"
                  />
                ) : null}
              </div>

              <div className="relative ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  aria-expanded={activePicker === "model"}
                  onClick={() => togglePicker("model")}
                  className="flex h-8 max-w-44 items-center gap-1 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
                {activePicker === "model" ? (
                  <div className="absolute right-16 bottom-full z-50 mb-2 max-h-64 w-64 overflow-y-auto rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10">
                    {models.map((model) => (
                      <PickerMenuItem
                        key={`${model.provider}:${model.id}`}
                        selected={
                          model.id === selectedModel && model.providerName === selectedProvider
                        }
                        onClick={() => {
                          onSelectModel(model)
                          setActivePicker(null)
                        }}
                      >
                        <FileText />
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
                        <span className="shrink-0 text-[10px] text-ui-muted">{model.provider}</span>
                      </PickerMenuItem>
                    ))}
                  </div>
                ) : null}
                <ComposerIconButton label="语音输入">
                  <Mic />
                </ComposerIconButton>
                <Button
                  type="submit"
                  size="icon"
                  aria-label="发送"
                  title="发送"
                  disabled={!draft.trim() || !selectedProject || sending}
                  className="ml-1 size-8 rounded-full bg-foreground text-background hover:bg-foreground/85 disabled:bg-ui-muted disabled:text-background disabled:opacity-55"
                >
                  {sending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

function Composer({
  id,
  draft,
  sending,
  running,
  models,
  selectedModel,
  selectedProvider,
  modelLabel,
  permissionMode,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onSelectModel,
  onSelectPermissionMode,
}: {
  id: string
  draft: string
  sending: boolean
  running: boolean
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  modelLabel: string
  permissionMode: DesktopPermissionMode
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onInterrupt: () => void
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<"model" | "permission" | null>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const permissionLabel = resolvePermissionModeLabel(permissionMode)

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (composerRef.current?.contains(event.target as Node)) return
      setActivePicker(null)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActivePicker(null)
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer)
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [])

  return (
    <div ref={composerRef} className="relative z-10 shrink-0 bg-conversation px-4 pb-4">
      <form
        className="mx-auto w-full max-w-190 rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <label htmlFor={id} className="sr-only">
          输入消息
        </label>
        <textarea
          id={id}
          value={draft}
          rows={2}
          placeholder="随心输入"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              onSubmit()
            }
          }}
          className="block max-h-44 min-h-20 w-full resize-none bg-transparent px-4 pt-4 text-[13px] leading-6 text-foreground outline-none placeholder:text-placeholder"
        />
        <div className="flex h-12 items-center gap-1 px-3 pb-2">
          <ComposerIconButton label="添加附件">
            <Plus />
          </ComposerIconButton>
          <div className="relative ml-1">
            <button
              type="button"
              aria-expanded={activePicker === "permission"}
              onClick={() =>
                setActivePicker((current) => (current === "permission" ? null : "permission"))
              }
              className="flex h-8 max-w-36 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ShieldCheck className="size-3.5 shrink-0" />
              <span className="truncate">{permissionLabel}</span>
              <ChevronDown className="size-3 shrink-0" />
            </button>
            {activePicker === "permission" ? (
              <PermissionModeMenu
                selected={permissionMode}
                onSelect={(nextMode) => {
                  onSelectPermissionMode(nextMode)
                  setActivePicker(null)
                }}
                className="absolute bottom-full left-0 z-50 mb-2 w-64"
              />
            ) : null}
          </div>
          <div className="relative ml-auto flex items-center gap-0.5">
            <button
              type="button"
              aria-expanded={activePicker === "model"}
              onClick={() => setActivePicker((current) => (current === "model" ? null : "model"))}
              className="flex h-8 max-w-44 items-center gap-1 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="truncate">{modelLabel}</span>
              <ChevronDown className="size-3 shrink-0" />
            </button>
            {activePicker === "model" ? (
              <div className="absolute right-16 bottom-full z-50 mb-2 max-h-64 w-64 overflow-y-auto rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10">
                {models.map((model) => (
                  <PickerMenuItem
                    key={`${model.provider}:${model.id}`}
                    selected={model.id === selectedModel && model.providerName === selectedProvider}
                    onClick={() => {
                      onSelectModel(model)
                      setActivePicker(null)
                    }}
                  >
                    <FileText />
                    <span className="min-w-0 flex-1 truncate">{model.label}</span>
                    <span className="shrink-0 text-[10px] text-ui-muted">{model.provider}</span>
                  </PickerMenuItem>
                ))}
              </div>
            ) : null}
            <ComposerIconButton label="语音输入">
              <Mic />
            </ComposerIconButton>
            {running ? (
              <Button
                type="button"
                size="icon"
                aria-label="停止生成"
                title="停止生成"
                onClick={onInterrupt}
                className="ml-1 size-8 rounded-full bg-foreground text-background hover:bg-foreground/85"
              >
                <CircleStop className="size-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                aria-label="发送"
                title="发送"
                disabled={!draft.trim() || sending}
                className="ml-1 size-8 rounded-full bg-foreground text-background hover:bg-foreground/85 disabled:bg-ui-muted disabled:text-background disabled:opacity-55"
              >
                {sending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

function ErrorBanner({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-destructive/15 bg-destructive/6 px-4 py-2.5 text-xs text-destructive"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 leading-5 break-words whitespace-pre-wrap">{message}</span>
      <button
        type="button"
        aria-label="关闭错误提示"
        onClick={onClose}
        className="grid size-6 place-items-center rounded-md hover:bg-destructive/10 [&_svg]:size-3.5"
      >
        <X />
      </button>
    </div>
  )
}

const permissionModeOptions: Array<{
  value: DesktopPermissionMode
  label: string
  description: string
}> = [
  {
    value: "default",
    label: "手动批准",
    description: "写入、命令等敏感操作会请求确认。",
  },
  {
    value: "plan",
    label: "计划模式",
    description: "保持只读分析，适合先审方案。",
  },
  {
    value: "full_auto",
    label: "自动批准",
    description: "尽量自动放行工具操作。",
  },
]

function PermissionModeMenu({
  selected,
  onSelect,
  className,
}: {
  selected: DesktopPermissionMode
  onSelect: (mode: DesktopPermissionMode) => void
  className?: string
}): React.JSX.Element {
  return (
    <div
      role="menu"
      className={cn(
        "rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10",
        className
      )}
    >
      {permissionModeOptions.map((mode) => (
        <button
          key={mode.value}
          type="button"
          role="menuitemradio"
          aria-checked={selected === mode.value}
          onClick={() => onSelect(mode.value)}
          className={cn(
            "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            selected === mode.value && "bg-muted"
          )}
        >
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ui-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-foreground">{mode.label}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-ui-muted">
              {mode.description}
            </span>
          </span>
          {selected === mode.value ? <Check className="mt-0.5 size-3.5 shrink-0" /> : null}
        </button>
      ))}
    </div>
  )
}

function StartPickerButton({
  label,
  expanded,
  onClick,
  children,
}: {
  label: string
  expanded: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-haspopup="menu"
      onClick={onClick}
      className={cn(
        "flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-ui-foreground transition-colors hover:bg-background/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        expanded && "bg-background/85"
      )}
    >
      {children}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown className="size-3 text-ui-muted" />
    </button>
  )
}

function PickerMenuItem({
  selected,
  onClick,
  children,
}: {
  selected?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ui-muted",
        selected && "bg-muted"
      )}
    >
      {children}
      {selected ? <Check className="ml-auto size-3.5 text-foreground" /> : null}
    </button>
  )
}

function HeaderIconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "grid size-8 place-items-center rounded-lg text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4",
        pressed && "bg-muted text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function ComposerIconButton({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid size-8 place-items-center rounded-md text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

function resolveModelLabel(
  models: DesktopModel[],
  modelId: string | null,
  providerName: string | null
): string {
  if (!modelId) return "选择模型"
  return (
    models.find((model) => model.id === modelId && model.providerName === providerName)?.label ??
    models.find((model) => model.id === modelId)?.label ??
    modelId
  )
}

function resolvePermissionModeLabel(mode: DesktopPermissionMode): string {
  return permissionModeOptions.find((option) => option.value === mode)?.label ?? "手动批准"
}

function projectName(path: string | undefined): string {
  if (!path) return "项目"
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).pop() || path
}

function appendDraftText(current: string, text: string): string {
  const trimmedText = text.trim()
  if (!trimmedText) return current
  if (!current.trim()) return trimmedText
  if (current.endsWith(" ") || current.endsWith("\n")) return `${current}${trimmedText}`
  return `${current} ${trimmedText}`
}
