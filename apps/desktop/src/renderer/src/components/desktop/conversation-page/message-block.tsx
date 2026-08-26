import { AlertCircle, Check, Copy, GitBranchPlus, PencilLine, ShieldCheck, X } from "lucide-react"
import { useEffect, useState } from "react"

import { messageTextContent } from "./message-content"
import { AssistantMessage } from "./message/assistant-message"
import { formatMessageTime } from "./message/format-message-time"
import { Button } from "@renderer/components/ui/button"
import { Message, MessageContent } from "@renderer/components/ui/message"
import { cn } from "@renderer/lib/utils"
import type {
  DesktopPermissionRequest,
  DesktopSessionMessage,
  DesktopSessionPart,
} from "@shared/session-types"

export function RunErrorNotice({ error }: { error?: string }): React.JSX.Element {
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

export function MessageBlock({
  message,
  parts,
  streaming,
  userActions,
  onOpenFile,
  onOpenReview,
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
  onOpenReview: (path?: string) => void
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
      onOpenReview={onOpenReview}
      onOpenTerminal={onOpenTerminal}
    />
  )
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
    if (editing) return
    const timer = window.setTimeout(() => setDraft(content), 0)
    return () => window.clearTimeout(timer)
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
              <Button
                type="submit"
                size="sm"
                disabled={!normalized}
                className="bg-foreground text-background hover:bg-foreground/85"
              >
                <Check data-icon="inline-start" />
                重新生成
              </Button>
            </div>
          </form>
        </MessageContent>
      </Message>
    )
  }

  return (
    <Message align="end" className="group/msg">
      <MessageContent className="items-end">
        <div className="max-w-[78%] rounded-xl bg-input/80 px-4 py-3 text-[13px] leading-6 whitespace-pre-wrap text-sidebar-foreground">
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

export function AssistantMessageActions({
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
  onFork?: (messageId: string) => void
}): React.JSX.Element | null {
  if (!message) return null
  return (
    <MessageToolbar align="start" timestamp={message.updatedAt}>
      {content.trim() ? (
        <MessageActionButton label="复制回复" onClick={() => onCopy(content)} disabled={disabled}>
          <Copy />
        </MessageActionButton>
      ) : null}
      {onFork ? (
        <MessageActionButton
          label="从这条回复分叉"
          onClick={() => onFork(message.id)}
          disabled={disabled}
        >
          <GitBranchPlus />
        </MessageActionButton>
      ) : null}
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
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground/50 hover:text-muted-foreground"
    >
      {children}
    </Button>
  )
}

export function PermissionCard({
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
        <Button
          type="button"
          variant="ghost"
          className="text-xs text-muted-foreground"
          onClick={() => onReply("denied")}
        >
          拒绝
        </Button>
        <Button
          type="button"
          variant="outline"
          className="text-xs"
          onClick={() => onReply("approved", "once")}
        >
          允许
        </Button>
      </div>
    </section>
  )
}
