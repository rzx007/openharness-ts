import {
  AlertCircle,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  CircleStop,
  FileText,
  Folder,
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
  TerminalSquare,
  Workflow,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import type {
  DesktopModel,
  DesktopPermissionRequest,
  DesktopProject,
  DesktopSessionMessage,
  DesktopSessionPart,
} from "@shared/session-types"

type ConversationPaneProps = {
  panelOpen: boolean
  onTogglePanel: () => void
}

export function ConversationPane({
  panelOpen,
  onTogglePanel,
}: ConversationPaneProps): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const openingSession = useDesktopSessionStore((state) => state.openingSession)
  const sending = useDesktopSessionStore((state) => state.sending)
  const error = useDesktopSessionStore((state) => state.error)
  const models = useDesktopSessionStore((state) => state.models)
  const selectedModel = useDesktopSessionStore((state) => state.selectedModel)
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const branch = useDesktopSessionStore((state) => state.branch)
  const projects = useDesktopSessionStore((state) => state.projects)
  const loadStatus = useDesktopSessionStore((state) => state.loadStatus)
  const startSession = useDesktopSessionStore((state) => state.startSession)
  const sendMessage = useDesktopSessionStore((state) => state.sendMessage)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const selectModel = useDesktopSessionStore((state) => state.selectModel)
  const interrupt = useDesktopSessionStore((state) => state.interrupt)
  const replyPermission = useDesktopSessionStore((state) => state.replyPermission)
  const clearError = useDesktopSessionStore((state) => state.clearError)
  const endRef = useRef<HTMLDivElement>(null)
  const hasSession = activeSessionId !== null

  useEffect(() => {
    if (!hasSession || !sessionView) return
    endRef.current?.scrollIntoView({ block: "end" })
  }, [hasSession, sessionView?.cursor, sessionView])

  const submitDraft = async (): Promise<void> => {
    const content = draft.trim()
    if (!content || sending) return
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
  const modelLabel = resolveModelLabel(models, currentModel)
  const running = Boolean(
    sessionView?.runs.some((run) => run.status === "pending" || run.status === "running") ||
      sessionView?.session.status === "running"
  )
  const pendingPermissions =
    sessionView?.permissions.filter((permission) => permission.status === "pending") ?? []

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-conversation">
      {hasSession ? (
        <header className="flex h-12 shrink-0 items-center border-b bg-background px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Folder className="size-4 shrink-0 text-ui-muted" strokeWidth={1.8} />
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
            <HeaderIconButton
              label={panelOpen ? "收起工具面板" : "展开工具面板"}
              pressed={panelOpen}
              onClick={onTogglePanel}
            >
              <PanelRight />
            </HeaderIconButton>
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
          onDraftChange={setDraft}
          onSubmit={() => void submitDraft()}
          onChooseProject={() => void chooseProject()}
          onSelectProject={(project) => void selectProject(project)}
          onSelectModel={selectModel}
        />
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <article className="mx-auto flex min-h-full w-full max-w-190 flex-col px-6 pt-7 pb-5">
              {openingSession && !sessionView ? (
                <div className="flex flex-1 items-center justify-center text-sm text-ui-muted">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  正在加载会话
                </div>
              ) : (
                <ConversationTranscript
                  messages={sessionView?.messages ?? []}
                  parts={sessionView?.parts ?? []}
                  running={running}
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

          <Composer
            id="message-composer"
            draft={draft}
            sending={sending}
            running={running}
            modelLabel={modelLabel}
            onDraftChange={setDraft}
            onSubmit={() => void submitDraft()}
            onInterrupt={() => void interrupt()}
          />
        </>
      )}
    </section>
  )
}

function ConversationTranscript({
  messages,
  parts,
  running,
}: {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  running: boolean
}): React.JSX.Element {
  const partsByMessage = useMemo(() => {
    const grouped = new Map<string, DesktopSessionPart[]>()
    for (const part of parts) {
      const current = grouped.get(part.messageId) ?? []
      current.push(part)
      grouped.set(part.messageId, current)
    }
    for (const current of grouped.values()) current.sort((a, b) => a.seq - b.seq)
    return grouped
  }, [parts])

  if (messages.length === 0 && !running) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ui-muted">
        这个会话还没有消息
      </div>
    )
  }

  return (
    <div className="space-y-7 text-[14px] leading-7 text-content-foreground">
      {messages.map((message) => (
        <MessageBlock
          key={message.id}
          message={message}
          parts={partsByMessage.get(message.id) ?? []}
        />
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

function MessageBlock({
  message,
  parts,
}: {
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
}): React.JSX.Element {
  if (message.role === "user") {
    const content = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] whitespace-pre-wrap rounded-xl bg-user-message px-4 py-3 text-[13px] leading-6 text-foreground">
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
    <div className="space-y-3">
      {parts.length === 0 ? (
        <span className="text-xs text-ui-muted">正在生成回复...</span>
      ) : (
        parts.map((part) => <MessagePart key={part.id} part={part} />)
      )}
    </div>
  )
}

function MessagePart({ part }: { part: DesktopSessionPart }): React.JSX.Element | null {
  if (part.type === "text") {
    if (!part.text) return null
    return <p className="whitespace-pre-wrap">{part.text}</p>
  }

  if (part.type === "reasoning") {
    return (
      <details className="text-xs text-ui-muted">
        <summary className="cursor-pointer select-none">思考过程</summary>
        <p className="mt-2 whitespace-pre-wrap">{part.text}</p>
      </details>
    )
  }

  if (part.type === "tool" || part.type === "tool_result") {
    return (
      <div className="flex min-w-0 items-start gap-2 rounded-lg border bg-background/55 px-3 py-2.5 text-xs">
        <TerminalSquare className="mt-0.5 size-3.5 shrink-0 text-ui-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-foreground">
              {part.toolName || (part.type === "tool" ? "运行工具" : "工具结果")}
            </span>
            <PartStatus status={part.status} />
          </div>
          {part.output !== undefined ? (
            <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-ui-muted">
              {formatOutput(part.output)}
            </pre>
          ) : null}
        </div>
      </div>
    )
  }

  if (part.type === "error" || part.isError) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        <span className="whitespace-pre-wrap">{part.text || formatOutput(part.output)}</span>
      </div>
    )
  }

  if (!part.text) return null
  return <p className="whitespace-pre-wrap text-xs text-ui-muted">{part.text}</p>
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
          <p className="mt-1 text-xs text-ui-muted">
            OpenHarness 请求运行 {permission.toolName}
          </p>
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

type StartPicker = "project" | "runtime" | "branch" | "model"

function NewConversationStart({
  draft,
  sending,
  loadStatus,
  projects,
  selectedProject,
  branch,
  models,
  selectedModel,
  onDraftChange,
  onSubmit,
  onChooseProject,
  onSelectProject,
  onSelectModel,
}: {
  draft: string
  sending: boolean
  loadStatus: "idle" | "loading" | "ready" | "error"
  projects: DesktopProject[]
  selectedProject: DesktopProject | null
  branch: string | null
  models: DesktopModel[]
  selectedModel: string | null
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onChooseProject: () => void
  onSelectProject: (project: DesktopProject) => void
  onSelectModel: (model: string) => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<StartPicker | null>(null)
  const [projectQuery, setProjectQuery] = useState("")
  const pickerAreaRef = useRef<HTMLDivElement>(null)
  const visibleProjects = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())
  )
  const modelLabel = resolveModelLabel(models, selectedModel)

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
    <div className="min-h-0 flex-1 px-5 py-5">
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
                  loadStatus === "loading"
                    ? "加载项目..."
                    : selectedProject?.name ?? "选择项目"
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
                      <p className="px-2 py-5 text-center text-xs text-ui-muted">
                        没有匹配的项目
                      </p>
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
              <button
                type="button"
                className="ml-1 flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ShieldCheck className="size-3.5" />
                帮我批准
              </button>

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
                        selected={model.id === selectedModel}
                        onClick={() => {
                          onSelectModel(model.id)
                          setActivePicker(null)
                        }}
                      >
                        <FileText />
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
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
  modelLabel,
  onDraftChange,
  onSubmit,
  onInterrupt,
}: {
  id: string
  draft: string
  sending: boolean
  running: boolean
  modelLabel: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onInterrupt: () => void
}): React.JSX.Element {
  return (
    <div className="relative z-10 shrink-0 bg-conversation px-4 pb-4">
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
          <button
            type="button"
            className="ml-1 flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ShieldCheck className="size-3.5" />
            帮我批准
          </button>
          <div className="ml-auto flex items-center gap-0.5">
            <span className="max-w-44 truncate px-2 text-xs text-ui-muted">{modelLabel}</span>
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

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-destructive/15 bg-destructive/6 px-4 py-2 text-xs text-destructive">
      <AlertCircle className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
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

function PartStatus({ status }: { status: DesktopSessionPart["status"] }): React.JSX.Element {
  const labels: Record<DesktopSessionPart["status"], string> = {
    pending: "等待中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已停止",
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] text-ui-muted">
      {status === "running" ? <LoaderCircle className="size-2.5 animate-spin" /> : null}
      {labels[status]}
    </span>
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

function resolveModelLabel(models: DesktopModel[], modelId: string | null): string {
  if (!modelId) return "选择模型"
  return models.find((model) => model.id === modelId)?.label ?? modelId
}

function projectName(path: string | undefined): string {
  if (!path) return "项目"
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).pop() || path
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (output === undefined || output === null) return ""
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}
