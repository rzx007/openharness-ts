import { Bot, ListFilter, MoreHorizontal, PanelRight } from "lucide-react"
import { useEffect, useState } from "react"

import { OpenWithSplitButton } from "@renderer/components/desktop/open-with"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@renderer/components/ui/message-scroller"
import { Spinner } from "@renderer/components/ui/spinner"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import { Composer } from "./composer"
import { HeaderIconButton } from "./controls"
import { NewConversationStart } from "./new-conversation-start"
import { PermissionCard } from "./message-block"
import { ProjectInfoButton } from "./project-info-popover"
import { SessionMoreMenu } from "./session-more-menu"
import { useSessionActionDialogs } from "./session-action-dialogs"
import { ConversationTranscript } from "./transcript"
import type { AddToComposerEventDetail, ConversationPaneProps } from "./types"
import { appendDraftText, resolveModelLabel } from "./utils"

function ConversationPane({
  panelOpen,
  onTogglePanel,
  onOpenFile,
  onOpenTerminal,
  onOpenAgents,
}: ConversationPaneProps): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const activeSessionId = useDesktopSessionStore((state) => state.activeSessionId)
  const sessionView = useDesktopSessionStore((state) => state.sessionView)
  const openingSession = useDesktopSessionStore((state) => state.openingSession)
  const sending = useDesktopSessionStore((state) => state.sending)
  const models = useDesktopSessionStore((state) => state.models)
  const selectedModel = useDesktopSessionStore((state) => state.selectedModel)
  const selectedProvider = useDesktopSessionStore((state) => state.selectedProvider)
  const selectedPermissionMode = useDesktopSessionStore((state) => state.selectedPermissionMode)
  const workspaceMode = useDesktopSessionStore((state) => state.workspaceMode)
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const branch = useDesktopSessionStore((state) => state.branch)
  const branches = useDesktopSessionStore((state) => state.branches)
  const projects = useDesktopSessionStore((state) => state.projects)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const loadStatus = useDesktopSessionStore((state) => state.loadStatus)
  const daemonStatus = useDesktopSessionStore((state) => state.daemonStatus)
  const startSession = useDesktopSessionStore((state) => state.startSession)
  const sendMessage = useDesktopSessionStore((state) => state.sendMessage)
  const editLatestMessage = useDesktopSessionStore((state) => state.editLatestMessage)
  const forkSession = useDesktopSessionStore((state) => state.forkSession)
  const chooseProject = useDesktopSessionStore((state) => state.chooseProject)
  const selectProject = useDesktopSessionStore((state) => state.selectProject)
  const selectOutsideProject = useDesktopSessionStore((state) => state.selectOutsideProject)
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
  const hasSession = activeSessionId !== null
  const archived = sessionView?.session.status === "archived"
  const sessionActions = useSessionActionDialogs()

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
  const hasAgentTasks = Boolean(
    sessionView?.tasks.some((task) => task.type === "agent" && task.childSessionId)
  )

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
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-x-hidden bg-conversation">
      {hasSession ? (
        <header className="flex h-12 shrink-0 items-center border-b bg-background px-3">
          <div className="flex min-w-0 items-center gap-2">
            <ProjectInfoButton
              selectedProject={selectedProject}
              projects={projects}
              cwd={sessionView?.session.cwd ?? null}
              sessions={sessions}
            />
            <h1 className="truncate text-[13px] font-semibold">{title}</h1>
            {sessionView?.syncStatus === "reconnecting" ? (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-ui-muted">
                <Spinner className="size-3" />
                正在重连
              </span>
            ) : null}
            {sessionView ? (
              <SessionMoreMenu
                session={sessionView.session}
                archived={archived}
                onRename={() => sessionActions.beginRename(sessionView.session)}
                onArchive={() => sessionActions.beginArchive(sessionView.session)}
                onDelete={() => sessionActions.beginDelete(sessionView.session)}
              />
            ) : (
              <HeaderIconButton label="更多操作">
                <MoreHorizontal />
              </HeaderIconButton>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {hasAgentTasks ? (
              <HeaderIconButton label="查看子智能体" onClick={onOpenAgents}>
                <Bot />
              </HeaderIconButton>
            ) : null}
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

      {!hasSession ? (
        <NewConversationStart
          draft={draft}
          sending={sending}
          loadStatus={loadStatus}
          daemonStatus={daemonStatus}
          projects={projects}
          selectedProject={selectedProject}
          workspaceMode={workspaceMode}
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
          onSelectOutsideProject={selectOutsideProject}
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
                      <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-ui-muted">
                        <Spinner className="size-4" />
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
              className="mx-auto mb-5 w-[min(760px,calc(100%-32px))] shrink-0"
              draft={draft}
              sending={sending}
              running={running}
              models={models}
              selectedModel={currentModel}
              selectedProvider={selectedProvider}
              modelLabel={modelLabel}
              permissionMode={selectedPermissionMode}
              canSubmit={Boolean(draft.trim())}
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
      {sessionActions.dialogs}
    </section>
  )
}

export { ConversationPane }
