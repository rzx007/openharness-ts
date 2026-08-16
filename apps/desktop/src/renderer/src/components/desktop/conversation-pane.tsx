import {
  AlertCircle,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  Folder,
  FolderClosed,
  GitBranch,
  GitBranchPlus,
  ListFilter,
  LoaderCircle,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelRight,
  PencilLine,
  Plus,
  Search,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react"
import { forwardRef, Fragment, useEffect, useMemo, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { AssistantMessage } from "@renderer/components/desktop/conversation/assistant-message"
import { buildConversationEntries } from "@renderer/components/desktop/conversation/conversation-turn-model"
import { formatMessageTime } from "@renderer/components/desktop/conversation/format-message-time"
import { OpenWithSplitButton } from "@renderer/components/desktop/open-with"
import { Marker, MarkerContent, MarkerIcon } from "@renderer/components/ui/marker"
import { Message, MessageContent } from "@renderer/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@renderer/components/ui/message-scroller"
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
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const branch = useDesktopSessionStore((state) => state.branch)
  const branches = useDesktopSessionStore((state) => state.branches)
  const projects = useDesktopSessionStore((state) => state.projects)
  const loadStatus = useDesktopSessionStore((state) => state.loadStatus)
  const startSession = useDesktopSessionStore((state) => state.startSession)
  const sendMessage = useDesktopSessionStore((state) => state.sendMessage)
  const editLatestMessage = useDesktopSessionStore((state) => state.editLatestMessage)
  const forkSession = useDesktopSessionStore((state) => state.forkSession)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const checkoutBranch = useDesktopSessionStore((state) => state.checkoutBranch)
  const createAndCheckoutBranch = useDesktopSessionStore((state) => state.createAndCheckoutBranch)
  const selectModel = useDesktopSessionStore((state) => state.selectModel)
  const selectPermissionMode = useDesktopSessionStore((state) => state.selectPermissionMode)
  const updateSessionModel = useDesktopSessionStore((state) => state.updateSessionModel)
  const updateSessionPermissionMode = useDesktopSessionStore(
    (state) => state.updateSessionPermissionMode
  )
  const interrupt = useDesktopSessionStore((state) => state.interrupt)
  const replyPermission = useDesktopSessionStore((state) => state.replyPermission)
  const clearError = useDesktopSessionStore((state) => state.clearError)
  const hasSession = activeSessionId !== null
  const archived = sessionView?.session.status === "archived"

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

  const copyAssistantMessage = async (content: string): Promise<void> => {
    await window.desktop.clipboard.writeText(content)
  }

  const forkFromAssistantMessage = async (messageId: string): Promise<void> => {
    if (!activeSessionId || archived || running) return
    await forkSession(activeSessionId, { afterMessageId: messageId })
  }

  const editLatestUserMessage = async (content: string): Promise<void> => {
    if (archived || running) return
    await editLatestMessage(content)
  }

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
            <FolderClosed className="size-3.5 shrink-0 text-ui-muted" strokeWidth={1.8} />
            <h1 className="truncate text-[13px] font-medium">{title}</h1>
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
              className="grid size-7 shrink-0 place-items-center rounded-md text-ui-muted hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5"
            >
              <MoreHorizontal />
            </button>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <OpenWithSplitButton folderPath={sessionView?.session.cwd ?? selectedProject?.path} />
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
          selectedProjectGit={selectedProjectGit}
          branch={branch}
          branches={branches}
          models={models}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedPermissionMode={selectedPermissionMode}
          panelOpen={panelOpen}
          onDraftChange={setDraft}
          onSubmit={() => void submitDraft()}
          onChooseProject={() => void chooseProject()}
          onSelectProject={(project) => void selectProject(project)}
          onCheckoutBranch={checkoutBranch}
          onCreateAndCheckoutBranch={createAndCheckoutBranch}
          onSelectModel={(model) => void selectModel(model)}
          onSelectPermissionMode={(permissionMode) => void selectPermissionMode(permissionMode)}
          onTogglePanel={onTogglePanel}
        />
      ) : (
        <>
          <MessageScrollerProvider
            key={activeSessionId ?? "new-session"}
            autoScroll
            defaultScrollPosition="last-anchor"
            scrollPreviousItemPeek={72}
          >
            <MessageScroller className="min-h-0 min-w-0 flex-1">
              <MessageScrollerViewport className="overflow-x-hidden">
                <MessageScrollerContent className="mx-auto min-h-full w-full max-w-190 min-w-0 gap-6 px-6 pt-7 pb-5 text-content-foreground">
                  {openingSession && !sessionView ? (
                    <MessageScrollerItem>
                      <div className="flex min-h-80 items-center justify-center text-sm text-ui-muted">
                        <LoaderCircle className="mr-2 size-4 animate-spin" />
                        正在加载会话
                      </div>
                    </MessageScrollerItem>
                  ) : (
                    <ConversationTranscript
                      messages={sessionView?.messages ?? []}
                      parts={sessionView?.parts ?? []}
                      runs={sessionView?.runs ?? []}
                      running={running}
                      canEditLastUserMessage={!archived && !running && !sending}
                      onEditLastUserMessage={(content) => void editLatestUserMessage(content)}
                      onCopyAssistantMessage={(content) => void copyAssistantMessage(content)}
                      onForkAssistantMessage={(messageId) =>
                        void forkFromAssistantMessage(messageId)
                      }
                      onOpenFile={onOpenFile}
                      onOpenTerminal={onOpenTerminal}
                    />
                  )}

                  {pendingPermissions.map((permission) => (
                    <MessageScrollerItem
                      key={permission.id}
                      messageId={`permission-${permission.id}`}
                    >
                      <PermissionCard
                        permission={permission}
                        onReply={(status, decision) =>
                          void replyPermission(permission.id, status, decision)
                        }
                      />
                    </MessageScrollerItem>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton className="bottom-5" />
            </MessageScroller>
          </MessageScrollerProvider>

          {archived ? (
            <div className="mx-auto mb-5 flex h-12 w-[min(760px,calc(100%-32px))] shrink-0 items-center justify-center rounded-lg border border-border bg-background/90 text-xs text-muted-foreground shadow-sm">
              {"此会话已归档，只能查看历史内容"}
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
  canEditLastUserMessage,
  onEditLastUserMessage,
  onCopyAssistantMessage,
  onForkAssistantMessage,
  onOpenFile,
  onOpenTerminal,
}: {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  running: boolean
  canEditLastUserMessage: boolean
  onEditLastUserMessage: (content: string) => void
  onCopyAssistantMessage: (content: string) => void
  onForkAssistantMessage: (messageId: string) => void
  onOpenFile: (path: string, line?: number) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const entries = useMemo(
    () => buildConversationEntries(messages, parts, runs),
    [messages, parts, runs]
  )
  const lastTurn = [...entries].reverse().find((entry) => entry.type === "turn")
  const lastUserMessage = [...entries]
    .reverse()
    .flatMap((entry) =>
      entry.type === "turn" && entry.turn.userMessage ? [entry.turn.userMessage] : []
    )[0]
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
      <MessageScrollerItem>
        <div className="flex min-h-80 items-center justify-center text-sm text-ui-muted">
          这个会话还没有消息
        </div>
      </MessageScrollerItem>
    )
  }

  return (
    <>
      {entries.map((entry) => {
        if (entry.type === "system") {
          return (
            <MessageScrollerItem key={entry.system.id} messageId={entry.system.id}>
              <MessageBlock
                message={entry.system.message}
                parts={entry.system.parts}
                streaming={false}
                onOpenFile={onOpenFile}
                onOpenTerminal={onOpenTerminal}
              />
            </MessageScrollerItem>
          )
        }
        const turnFailures = failedRuns.filter(
          (run) =>
            entry.turn.runIds.includes(run.id) ||
            (Boolean(run.inputId) && run.inputId === entry.turn.inputId)
        )
        return (
          <Fragment key={entry.turn.id}>
            {entry.turn.userMessage ? (
              <MessageScrollerItem
                messageId={entry.turn.userMessage.id}
                scrollAnchor
                className="pt-2"
              >
                <MessageBlock
                  message={entry.turn.userMessage}
                  parts={entry.turn.userParts}
                  streaming={false}
                  userActions={{
                    canEdit:
                      canEditLastUserMessage && entry.turn.userMessage.id === lastUserMessage?.id,
                    onEdit: onEditLastUserMessage,
                  }}
                  onOpenFile={onOpenFile}
                  onOpenTerminal={onOpenTerminal}
                />
              </MessageScrollerItem>
            ) : null}
            {entry.turn.assistantMessages.length > 0 ? (
              <MessageScrollerItem
                messageId={entry.turn.assistantMessages.at(-1)?.id ?? `${entry.turn.id}-assistant`}
                className="group/msg min-w-0"
              >
                <AssistantMessage
                  parts={entry.turn.assistantParts}
                  streaming={running && entry === lastTurn}
                  onOpenFile={onOpenFile}
                  onOpenTerminal={onOpenTerminal}
                />
                <AssistantMessageActions
                  message={entry.turn.assistantMessages.at(-1)}
                  content={messageTextContent(entry.turn.assistantParts)}
                  disabled={running && entry === lastTurn}
                  onCopy={onCopyAssistantMessage}
                  onFork={onForkAssistantMessage}
                />
              </MessageScrollerItem>
            ) : null}
            {turnFailures.map((run) => (
              <MessageScrollerItem key={run.id} messageId={`run-error-${run.id}`}>
                <RunErrorNotice error={run.error} />
              </MessageScrollerItem>
            ))}
          </Fragment>
        )
      })}
      {unattachedFailures.map((run) => (
        <MessageScrollerItem key={run.id} messageId={`run-error-${run.id}`}>
          <RunErrorNotice error={run.error} />
        </MessageScrollerItem>
      ))}
      {running ? (
        <MessageScrollerItem messageId="conversation-running-status">
          <Marker>
            <MarkerIcon>
              <LoaderCircle className="animate-spin" />
            </MarkerIcon>
            <MarkerContent>OpenHarness 正在处理</MarkerContent>
          </Marker>
        </MessageScrollerItem>
      ) : null}
    </>
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
  userActions,
  onOpenFile,
  onOpenTerminal,
}: {
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
  streaming: boolean
  userActions?: {
    canEdit: boolean
    onEdit: (content: string) => void
  }
  onOpenFile: (path: string, line?: number) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  if (message.role === "user") {
    const content = messageTextContent(parts)
    return (
      <UserMessageBlock content={content} timestamp={message.updatedAt} userActions={userActions} />
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

function messageTextContent(parts: DesktopSessionPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
}

function UserMessageBlock({
  content,
  timestamp,
  userActions,
}: {
  content: string
  timestamp: number
  userActions?: { canEdit: boolean; onEdit: (content: string) => void }
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const canEdit = Boolean(userActions?.canEdit && content.trim())

  useEffect(() => {
    if (!editing) setDraft(content)
  }, [content, editing])

  if (editing && userActions) {
    const normalized = draft.trim()
    return (
      <Message align="end" className="group/msg">
        <MessageContent className="items-end">
          <form
            className="flex w-full max-w-[78%] flex-col items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!normalized) return
              setEditing(false)
              userActions.onEdit(normalized)
            }}
          >
            <label className="sr-only" htmlFor="latest-message-editor">
              编辑最新消息
            </label>
            <textarea
              id="latest-message-editor"
              autoFocus
              value={draft}
              rows={Math.max(2, Math.min(8, draft.split("\n").length))}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  if (!normalized) return
                  setEditing(false)
                  userActions.onEdit(normalized)
                }
                if (event.key === "Escape") setEditing(false)
              }}
              className="min-h-20 w-full resize-y rounded-xl bg-user-message/70 px-4 py-3 text-[13px] leading-6 whitespace-pre-wrap text-foreground outline-none"
            />
            <div className="flex items-center gap-1">
              <MessageActionButton label="取消编辑" onClick={() => setEditing(false)}>
                <X />
              </MessageActionButton>
              <button
                type="submit"
                disabled={!normalized}
                className="inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-45"
              >
                <Check className="size-3.5" />
                重新生成
              </button>
            </div>
          </form>
        </MessageContent>
      </Message>
    )
  }

  return (
    <Message align="end" className="group/msg">
      <MessageContent className="items-end">
        <div className="max-w-[78%] rounded-xl bg-user-message/50 px-4 py-3 text-[13px] leading-6 whitespace-pre-wrap text-foreground">
          {content || "已发送消息"}
        </div>
        <MessageToolbar align="end" timestamp={timestamp}>
          {canEdit ? (
            <MessageActionButton label="重新编辑" onClick={() => setEditing(true)}>
              <PencilLine />
            </MessageActionButton>
          ) : null}
        </MessageToolbar>
      </MessageContent>
    </Message>
  )
}

function AssistantMessageActions({
  message,
  content,
  disabled,
  onCopy,
  onFork,
}: {
  message?: DesktopSessionMessage
  content: string
  disabled: boolean
  onCopy: (content: string) => void
  onFork: (messageId: string) => void
}): React.JSX.Element | null {
  if (!message) return null
  return (
    <MessageToolbar align="start" timestamp={message.updatedAt}>
      {content.trim() ? (
        <MessageActionButton label="复制回复" onClick={() => onCopy(content)} disabled={disabled}>
          <Copy />
        </MessageActionButton>
      ) : null}
      <MessageActionButton
        label="从这条回复分叉"
        onClick={() => onFork(message.id)}
        disabled={disabled}
      >
        <GitBranchPlus />
      </MessageActionButton>
    </MessageToolbar>
  )
}

function MessageToolbar({
  align,
  timestamp,
  children,
}: {
  align: "start" | "end"
  timestamp: number
  children?: React.ReactNode
}): React.JSX.Element {
  const label = formatMessageTime(timestamp)
  const absolute = new Date(timestamp).toLocaleString()
  const time = (
    <time dateTime={new Date(timestamp).toISOString()} title={absolute} className="ml-0.5 shrink-0">
      {label}
    </time>
  )

  return (
    <div
      className={cn(
        "mt-1.5 flex h-7 items-center gap-0.5 text-xs text-ui-muted",
        "pointer-events-none opacity-0 transition-opacity",
        "group-hover/msg:pointer-events-auto group-hover/msg:opacity-100",
        "group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100",
        align === "end" ? "justify-end" : "justify-start"
      )}
    >
      {children}
      {time}
    </div>
  )
}

function MessageActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-ui-muted/50 transition-colors hover:bg-muted hover:text-ui-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3"
    >
      {children}
    </button>
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
          <p className="mt-1 text-xs text-ui-muted">
            {"OpenHarness 请求运行 "}
            {permission.toolName}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onReply("denied")}
          className="h-8 rounded-md px-3 text-xs text-ui-muted hover:bg-muted hover:text-foreground"
        >
          鎷掔粷
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
  selectedProjectGit,
  branch,
  branches,
  models,
  selectedModel,
  selectedProvider,
  selectedPermissionMode,
  panelOpen,
  onDraftChange,
  onSubmit,
  onChooseProject,
  onSelectProject,
  onCheckoutBranch,
  onCreateAndCheckoutBranch,
  onSelectModel,
  onSelectPermissionMode,
  onTogglePanel,
}: {
  draft: string
  sending: boolean
  loadStatus: "idle" | "loading" | "ready" | "error"
  projects: DesktopProject[]
  selectedProject: DesktopProject | null
  selectedProjectGit: boolean
  branch: string | null
  branches: string[]
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  selectedPermissionMode: DesktopPermissionMode
  panelOpen: boolean
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onChooseProject: () => void
  onSelectProject: (project: DesktopProject) => void
  onCheckoutBranch: (branch: string) => Promise<void>
  onCreateAndCheckoutBranch: (branch: string) => Promise<void>
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
  onTogglePanel: () => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<StartPicker | null>(null)
  const [projectQuery, setProjectQuery] = useState("")
  const [branchQuery, setBranchQuery] = useState("")
  const [creatingBranch, setCreatingBranch] = useState(false)
  const visibleProjects = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())
  )
  const normalizedBranchQuery = branchQuery.trim()
  const branchItems = branches ?? []
  const visibleBranches = branchItems.filter((item) =>
    item.toLocaleLowerCase().includes(normalizedBranchQuery.toLocaleLowerCase())
  )
  const canCreateBranch =
    normalizedBranchQuery.length > 0 && !branchItems.some((item) => item === normalizedBranchQuery)
  const isGitProject = selectedProjectGit
  const modelLabel = resolveModelLabel(models, selectedModel, selectedProvider)
  const permissionLabel = resolvePermissionModeLabel(selectedPermissionMode)

  const closePicker = (): void => setActivePicker(null)

  return (
    <div className="relative min-h-0 flex-1 px-5 py-5">
      {selectedProject && !panelOpen ? (
        <div className="absolute top-4 right-4">
          <HeaderIconButton label="展开工具面板" onClick={onTogglePanel}>
            <PanelRight />
          </HeaderIconButton>
        </div>
      ) : null}
      <div className="mx-auto flex h-full w-full max-w-190 flex-col items-center justify-center pb-[5vh]">
        <div className="mb-7 flex flex-col items-center text-center">
          <Workflow
            aria-hidden="true"
            className="mb-5 size-9 text-ui-muted/65"
            strokeWidth={1.45}
          />
          <h2 className="text-[26px] leading-9 font-medium text-foreground">
            {selectedProject ? (
              <>
                {"要在 "}
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

        <div className="relative w-full">
          <div className="mx-3 flex h-12 min-w-0 items-start gap-0.5 rounded-t-2xl bg-muted/70 px-2.5 pt-2">
            <Popover
              open={activePicker === "project"}
              onOpenChange={(open) => setActivePicker(open ? "project" : null)}
            >
              <PopoverTrigger
                render={
                  <StartPickerButton
                    label={
                      loadStatus === "loading"
                        ? "加载项目..."
                        : (selectedProject?.name ?? "选择项目")
                    }
                    expanded={activePicker === "project"}
                  >
                    <Folder />
                  </StartPickerButton>
                }
              />
              <PopoverContent
                role="menu"
                side="top"
                align="start"
                sideOffset={8}
                className="w-[290px] gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
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
                        closePicker()
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
                      closePicker()
                    }}
                  >
                    <Plus />
                    <span>选择其他文件夹</span>
                  </PickerMenuItem>
                </div>
              </PopoverContent>
            </Popover>

            <Popover
              open={activePicker === "runtime"}
              onOpenChange={(open) => setActivePicker(open ? "runtime" : null)}
            >
              <PopoverTrigger
                render={
                  <StartPickerButton label="本地" expanded={activePicker === "runtime"}>
                    <Monitor />
                  </StartPickerButton>
                }
              />
              <PopoverContent
                role="menu"
                side="top"
                align="start"
                sideOffset={8}
                className="w-44 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
              >
                <PickerMenuItem selected onClick={closePicker}>
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
              </PopoverContent>
            </Popover>

            {isGitProject ? (
              <Popover
                open={activePicker === "branch"}
                onOpenChange={(open) => setActivePicker(open ? "branch" : null)}
              >
                <PopoverTrigger
                  render={
                    <StartPickerButton
                      label={branch ?? "选择分支"}
                      expanded={activePicker === "branch"}
                    >
                      <GitBranch />
                    </StartPickerButton>
                  }
                />
                <PopoverContent
                  role="menu"
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-[320px] gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
                >
                  <label className="flex h-9 items-center gap-2 px-2 text-ui-muted">
                    <Search className="size-3.5 shrink-0" />
                    <span className="sr-only">搜索分支</span>
                    <input
                      autoFocus
                      value={branchQuery}
                      placeholder={`搜索 ${selectedProject?.name ?? "项目"} 分支`}
                      onChange={(event) => setBranchQuery(event.target.value)}
                      className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-placeholder"
                    />
                  </label>
                  <div className="border-b px-2 pt-1 pb-2 text-[11px] text-ui-muted">分支</div>
                  <div className="max-h-56 overflow-y-auto py-0.5">
                    {visibleBranches.map((item) => (
                      <PickerMenuItem
                        key={item}
                        selected={item === branch}
                        onClick={() => {
                          if (item !== branch) void onCheckoutBranch(item)
                          setBranchQuery("")
                          closePicker()
                        }}
                      >
                        <GitBranch />
                        <span className="min-w-0 flex-1 truncate">{item}</span>
                      </PickerMenuItem>
                    ))}
                    {visibleBranches.length === 0 ? (
                      <p className="px-2 py-5 text-center text-xs text-ui-muted">没有匹配的分支</p>
                    ) : null}
                  </div>
                  {canCreateBranch ? (
                    <div className="mt-1 border-t pt-1">
                      <PickerMenuItem
                        disabled={creatingBranch}
                        onClick={() => {
                          const nextBranch = normalizedBranchQuery
                          setCreatingBranch(true)
                          void onCreateAndCheckoutBranch(nextBranch)
                            .then(() => {
                              setBranchQuery("")
                              closePicker()
                            })
                            .finally(() => setCreatingBranch(false))
                        }}
                      >
                        {creatingBranch ? <LoaderCircle className="animate-spin" /> : <Plus />}
                        <span className="min-w-0 flex-1 truncate">
                          {"创建并检出 "}
                          {normalizedBranchQuery}
                        </span>
                      </PickerMenuItem>
                    </div>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : null}
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
              className="block max-h-48 min-h-24 w-full resize-none bg-transparent px-4 pt-4 text-[13px] leading-6 text-foreground outline-none placeholder:text-placeholder/60"
            />

            <div className="flex h-12 items-center gap-1 px-3 pb-2">
              <ComposerIconButton label="添加附件">
                <Plus />
              </ComposerIconButton>
              <Popover
                open={activePicker === "permission"}
                onOpenChange={(open) => setActivePicker(open ? "permission" : null)}
              >
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-expanded={activePicker === "permission"}
                      className="ml-1 flex h-8 max-w-36 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <ShieldCheck className="size-3.5 shrink-0" />
                      <span className="truncate">{permissionLabel}</span>
                      <ChevronDown className="size-3 shrink-0" />
                    </button>
                  }
                />
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-56 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
                >
                  <PermissionModeMenu
                    selected={selectedPermissionMode}
                    onSelect={(permissionMode) => {
                      onSelectPermissionMode(permissionMode)
                      closePicker()
                    }}
                  />
                </PopoverContent>
              </Popover>
              <div className="ml-auto flex items-center gap-1">
                <Popover
                  open={activePicker === "model"}
                  onOpenChange={(open) => setActivePicker(open ? "model" : null)}
                >
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        aria-expanded={activePicker === "model"}
                        className="flex h-8 max-w-52 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <span className="truncate">{modelLabel}</span>
                        <ChevronDown className="size-3 shrink-0" />
                      </button>
                    }
                  />
                  <PopoverContent
                    side="top"
                    align="end"
                    sideOffset={8}
                    className="w-64 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
                  >
                    <div className="max-h-64 overflow-y-auto py-0.5">
                      {models.map((model) => (
                        <PickerMenuItem
                          key={`${model.providerName}:${model.id}`}
                          selected={
                            model.id === selectedModel && model.providerName === selectedProvider
                          }
                          onClick={() => {
                            onSelectModel(model)
                            closePicker()
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{model.label}</span>
                        </PickerMenuItem>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
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
  const permissionLabel = resolvePermissionModeLabel(permissionMode)
  const closePicker = (): void => setActivePicker(null)

  return (
    <form
      className="mx-auto mb-5 w-[min(760px,calc(100%-32px))] shrink-0 rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label htmlFor={id} className="sr-only">
        输入对话内容
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
        className="block max-h-44 min-h-18 w-full resize-none bg-transparent px-4 pt-3 text-[13px] leading-6 text-foreground outline-none placeholder:text-placeholder/65"
      />
      <div className="flex h-12 items-center gap-1 px-3 pb-2">
        <ComposerIconButton label="添加附件">
          <Plus />
        </ComposerIconButton>
        <Popover
          open={activePicker === "permission"}
          onOpenChange={(open) => setActivePicker(open ? "permission" : null)}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-expanded={activePicker === "permission"}
                className="ml-1 flex h-8 max-w-36 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ShieldCheck className="size-3.5 shrink-0" />
                <span className="truncate">{permissionLabel}</span>
                <ChevronDown className="size-3 shrink-0" />
              </button>
            }
          />
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-56 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
          >
            <PermissionModeMenu
              selected={permissionMode}
              onSelect={(mode) => {
                onSelectPermissionMode(mode)
                closePicker()
              }}
            />
          </PopoverContent>
        </Popover>
        <div className="ml-auto flex items-center gap-1">
          <Popover
            open={activePicker === "model"}
            onOpenChange={(open) => setActivePicker(open ? "model" : null)}
          >
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-expanded={activePicker === "model"}
                  className="flex h-8 max-w-52 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              }
            />
            <PopoverContent
              side="top"
              align="end"
              sideOffset={8}
              className="w-64 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
            >
              <div className="max-h-64 overflow-y-auto py-0.5">
                {models.map((model) => (
                  <PickerMenuItem
                    key={`${model.providerName}:${model.id}`}
                    selected={model.id === selectedModel && model.providerName === selectedProvider}
                    onClick={() => {
                      onSelectModel(model)
                      closePicker()
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.label}</span>
                  </PickerMenuItem>
                ))}
              </div>
            </PopoverContent>
          </Popover>
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
    <div role="menu" className={cn("text-popover-foreground", className)}>
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

const StartPickerButton = forwardRef<
  HTMLButtonElement,
  {
    label: string
    expanded: boolean
    children: React.ReactNode
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function StartPickerButton({ label, expanded, children, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={expanded}
      aria-haspopup="menu"
      className={cn(
        "flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-ui-foreground transition-colors hover:bg-background/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        expanded && "bg-background/85",
        className
      )}
      {...props}
    >
      {children}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown className="size-3 text-ui-muted" />
    </button>
  )
})

function PickerMenuItem({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ui-muted",
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
        "grid size-7 place-items-center rounded-md text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5",
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
  return permissionModeOptions.find((option) => option.value === mode)?.label ?? mode
}
function appendDraftText(current: string, text: string): string {
  const trimmedText = text.trim()
  if (!trimmedText) return current
  if (!current.trim()) return trimmedText
  if (current.endsWith(" ") || current.endsWith("\n")) return `${current}${trimmedText}`
  return `${current} ${trimmedText}`
}
