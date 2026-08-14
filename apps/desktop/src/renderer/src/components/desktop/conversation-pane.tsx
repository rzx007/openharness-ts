import {
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  ListFilter,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelRight,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Workflow,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"

type ConversationPaneProps = {
  panelOpen: boolean
  onTogglePanel: () => void
}

type LocalMessage = {
  id: number
  content: string
}

const changedFiles = [
  { path: "src/renderer/src/App.tsx", additions: 84, deletions: 221 },
  { path: "src/renderer/src/components/desktop/desktop-shell.tsx", additions: 72, deletions: 0 },
  { path: "src/renderer/src/assets/main.css", additions: 65, deletions: 31 },
]

export function ConversationPane({
  panelOpen,
  onTogglePanel,
}: ConversationPaneProps): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (messages.length === 0) return
    endRef.current?.scrollIntoView({ block: "end" })
  }, [messages])

  const submitDraft = (): void => {
    const content = draft.trim()
    if (!content) return

    setMessages((current) => [...current, { id: Date.now(), content }])
    setDraft("")
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-conversation">
      {messages.length > 0 && (
        <header className="flex h-12 shrink-0 items-center border-b bg-background px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Folder className="size-4 shrink-0 text-ui-muted" strokeWidth={1.8} />
            <h1 className="truncate text-[13px] font-semibold">复刻 Codex 桌面工作台</h1>
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
              className="flex h-8 items-center gap-2 rounded-lg border bg-background px-2.5 text-xs text-ui-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <FolderGit2 className="size-3.5 text-amber-500" />
              <ChevronDown className="size-3 text-ui-muted" />
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
      )}

      {messages.length === 0 ? (
        <NewConversationStart draft={draft} onDraftChange={setDraft} onSubmit={submitDraft} />
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <article className="mx-auto flex min-h-full w-full max-w-190 flex-col px-6 pt-7 pb-5">
              <div className="space-y-4 text-[14px] leading-7 text-content-foreground">
                <p>
                  已按你的要求整理了桌面工作台。主窗口现在使用自定义标题栏，左侧导航和右侧工具面板都可以独立收起，对话区域会自动占满剩余空间。
                </p>
                <p>
                  这套界面沿用现有的 <InlineCode>Tailwind CSS v4</InlineCode>、
                  <InlineCode>shadcn/ui</InlineCode> 和 Electron IPC，没有引入另一套样式体系。
                </p>

                <section>
                  <h2 className="mb-2 text-[14px] font-semibold text-foreground">实现细节：</h2>
                  <ul className="list-disc space-y-1.5 pl-6 marker:text-ui-muted">
                    <li>顶部工具栏可拖拽窗口，并接通最小化、最大化和关闭操作。</li>
                    <li>侧边栏保留项目、会话、通知和桌面宠物入口。</li>
                    <li>右侧 Panel 用于承载审阅、终端、浏览器、文件和侧边聊天。</li>
                    <li>编辑器支持本地发送，后续可以直接替换为真实会话数据流。</li>
                  </ul>
                </section>

                <p>
                  布局按照桌面工具的密度处理，正文保持可读宽度，窄窗口展开 Panel
                  时会自动让出左侧空间。
                </p>

                <ChangeSummary />

                <div className="flex items-center gap-1 pt-1 text-ui-muted">
                  <FeedbackButton label="复制">
                    <Copy />
                  </FeedbackButton>
                  <FeedbackButton label="有帮助">
                    <ThumbsUp />
                  </FeedbackButton>
                  <FeedbackButton label="没有帮助">
                    <ThumbsDown />
                  </FeedbackButton>
                  <FeedbackButton label="在新窗口打开">
                    <ExternalLink />
                  </FeedbackButton>
                  <span className="ml-1 text-[11px]">刚刚</span>
                </div>
              </div>

              {messages.map((message) => (
                <div key={message.id} className="mt-8 flex justify-end">
                  <div className="max-w-[78%] rounded-xl bg-user-message px-4 py-3 text-[13px] leading-6 text-foreground">
                    {message.content}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </article>
          </ScrollArea>

          <div className="relative z-10 shrink-0 bg-conversation px-4 pb-4">
            <form
              className="mx-auto w-full max-w-190 rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12"
              onSubmit={(event) => {
                event.preventDefault()
                submitDraft()
              }}
            >
              <label htmlFor="message-composer" className="sr-only">
                输入消息
              </label>
              <textarea
                id="message-composer"
                value={draft}
                rows={2}
                placeholder="随心输入"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    submitDraft()
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
                  <button
                    type="button"
                    className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    5.6 Sonnet
                    <ChevronDown className="size-3" />
                  </button>
                  <ComposerIconButton label="语音输入">
                    <Mic />
                  </ComposerIconButton>
                  <Button
                    type="submit"
                    size="icon"
                    aria-label="发送"
                    title="发送"
                    disabled={!draft.trim()}
                    className="ml-1 size-8 rounded-full bg-foreground text-background hover:bg-foreground/85 disabled:bg-ui-muted disabled:text-background disabled:opacity-55"
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </>
      )}
    </section>
  )
}

type StartPicker = "project" | "runtime" | "branch"

const projectOptions = [
  "OpenHarness-ts",
  "digital-employe-client-web-main",
  "zuu",
  "hermes-agent-ts",
]

const branchOptions = ["main", "develop", "feature/desktop-shell"]

function NewConversationStart({
  draft,
  onDraftChange,
  onSubmit,
}: {
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<StartPicker | null>(null)
  const [project, setProject] = useState<string | null>("OpenHarness-ts")
  const [runtime, setRuntime] = useState<"本地" | "沙箱">("本地")
  const [branch, setBranch] = useState("main")
  const [projectQuery, setProjectQuery] = useState("")
  const pickerAreaRef = useRef<HTMLDivElement>(null)
  const visibleProjects = projectOptions.filter((option) =>
    option.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase())
  )

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
            {project ? (
              <>
                要在{" "}
                <span className="underline decoration-foreground/25 underline-offset-4">
                  {project}
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
                label={project ?? "选择项目"}
                expanded={activePicker === "project"}
                onClick={() => togglePicker("project")}
              >
                <Folder />
              </StartPickerButton>

              {activePicker === "project" && (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-50 mb-2 w-[270px] rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10"
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
                    {visibleProjects.map((option) => (
                      <PickerMenuItem
                        key={option}
                        selected={option === project}
                        onClick={() => {
                          setProject(option)
                          setProjectQuery("")
                          setActivePicker(null)
                        }}
                      >
                        <Folder />
                        <span className="min-w-0 flex-1 truncate">{option}</span>
                      </PickerMenuItem>
                    ))}
                    {visibleProjects.length === 0 && (
                      <p className="px-2 py-5 text-center text-xs text-ui-muted">没有匹配的项目</p>
                    )}
                  </div>

                  <div className="mt-1 border-t pt-1">
                    <PickerMenuItem onClick={() => setActivePicker(null)}>
                      <Plus />
                      <span>新建项目</span>
                    </PickerMenuItem>
                    <PickerMenuItem
                      onClick={() => {
                        setProject(null)
                        setProjectQuery("")
                        setActivePicker(null)
                      }}
                    >
                      <X />
                      <span>不在项目中工作</span>
                    </PickerMenuItem>
                  </div>
                </div>
              )}
            </div>

            <div className="relative shrink-0">
              <StartPickerButton
                label={runtime}
                expanded={activePicker === "runtime"}
                onClick={() => togglePicker("runtime")}
              >
                {runtime === "本地" ? <Monitor /> : <Box />}
              </StartPickerButton>

              {activePicker === "runtime" && (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-50 mb-2 w-40 rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10"
                >
                  <PickerMenuItem
                    selected={runtime === "本地"}
                    onClick={() => {
                      setRuntime("本地")
                      setActivePicker(null)
                    }}
                  >
                    <Monitor />
                    <span>本地</span>
                  </PickerMenuItem>
                  <PickerMenuItem
                    selected={runtime === "沙箱"}
                    onClick={() => {
                      setRuntime("沙箱")
                      setActivePicker(null)
                    }}
                  >
                    <Box />
                    <span>沙箱</span>
                  </PickerMenuItem>
                </div>
              )}
            </div>

            <div className="relative min-w-0">
              <StartPickerButton
                label={branch}
                expanded={activePicker === "branch"}
                onClick={() => togglePicker("branch")}
              >
                <GitBranch />
              </StartPickerButton>

              {activePicker === "branch" && (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-50 mb-2 w-52 rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-black/10"
                >
                  {branchOptions.map((option) => (
                    <PickerMenuItem
                      key={option}
                      selected={option === branch}
                      onClick={() => {
                        setBranch(option)
                        setActivePicker(null)
                      }}
                    >
                      <GitBranch />
                      <span className="min-w-0 flex-1 truncate">{option}</span>
                    </PickerMenuItem>
                  ))}
                </div>
              )}
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

              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  5.6 Sonnet
                  <ChevronDown className="size-3" />
                </button>
                <ComposerIconButton label="语音输入">
                  <Mic />
                </ComposerIconButton>
                <Button
                  type="submit"
                  size="icon"
                  aria-label="发送"
                  title="发送"
                  disabled={!draft.trim()}
                  className="ml-1 size-8 rounded-full bg-foreground text-background hover:bg-foreground/85 disabled:bg-ui-muted disabled:text-background disabled:opacity-55"
                >
                  <ArrowUp className="size-4" />
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
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
      {selected && <Check className="ml-auto size-3.5 text-foreground" />}
    </button>
  )
}

function ChangeSummary(): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl bg-background ring-1 ring-black/8">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <span className="grid size-8 place-items-center rounded-lg bg-muted text-ui-muted">
          <FileCode2 className="size-4" />
        </span>
        <div>
          <h3 className="text-[13px] leading-5 font-semibold text-foreground">已编辑 6 个文件</h3>
          <p className="text-xs leading-4">
            <span className="text-emerald-600">+540</span>{" "}
            <span className="text-red-500">-274</span>
          </p>
        </div>
        <button
          type="button"
          className="ml-auto flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ui-muted hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          撤销 <RotateCcw className="size-3.5" />
        </button>
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Check className="size-3.5" />
          审核
        </button>
      </header>

      <div className="py-1">
        {changedFiles.map((file) => (
          <div key={file.path} className="flex items-center gap-3 px-4 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-ui-muted">{file.path}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-emerald-600">+{file.additions}</span>{" "}
              <span className="text-red-500">-{file.deletions}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function InlineCode({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <code className="rounded-md bg-code px-1.5 py-0.5 font-mono text-[0.9em] text-code-foreground">
      {children}
    </code>
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

function FeedbackButton({
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
      className="grid size-7 place-items-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}
