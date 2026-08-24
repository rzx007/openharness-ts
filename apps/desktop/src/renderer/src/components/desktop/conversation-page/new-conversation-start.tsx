import { Blobatar } from "@blobatar/react"
import { Box, Folder, GitBranch, Monitor, PanelRight, Plus, Search } from "lucide-react"
import { useState } from "react"
import "blobatar/motion.css"

import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Separator } from "@renderer/components/ui/separator"
import { Spinner } from "@renderer/components/ui/spinner"
import type { DesktopModel, DesktopPermissionMode, DesktopProject } from "@shared/session-types"
import { Composer } from "./composer"
import { HeaderIconButton, PickerMenuItem, StartPickerButton } from "./controls"
import type { LoadStatus, StartPicker } from "./types"
import { resolveModelLabel } from "./utils"

export function NewConversationStart({
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
  loadStatus: LoadStatus
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
  const [blobatarName] = useState(() => crypto.randomUUID())
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

  const closePicker = (): void => setActivePicker(null)

  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden px-5 py-5">
      {selectedProject && !panelOpen ? (
        <div className="absolute top-4 right-4">
          <HeaderIconButton label="展开工具面板" onClick={onTogglePanel}>
            <PanelRight />
          </HeaderIconButton>
        </div>
      ) : null}
      <div className="mx-auto flex h-full w-full max-w-190 min-w-0 flex-col items-center justify-center pb-[5vh]">
        <div className="mb-7 flex max-w-full min-w-0 flex-col items-center px-2 text-center">
          <Blobatar
            name={blobatarName}
            animate="always"
            size={64}
            className="mb-5"
            aria-hidden="true"
          />
          <h2 className="max-w-full text-[26px] leading-9 font-medium wrap-break-word text-foreground">
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

        <div className="relative w-full min-w-0">
          <div className="mx-3 flex h-10 min-w-0 items-center gap-0.5 overflow-hidden rounded-t-2xl bg-muted-foreground/5 px-2.5 pt-1">
            <div className="min-w-0">
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
                  className="w-72.5 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
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
                  <ScrollArea
                    horizontal={false}
                    className="max-h-44"
                    viewportClassName="max-h-44 flex-none"
                    contentClassName="py-0.5"
                  >
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
                  </ScrollArea>
                  <div className="mt-1 pt-1">
                    <Separator className="mb-1" />
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
            </div>

            <div className="min-w-0 shrink">
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
                  <PickerMenuItem
                    disabled
                    title="沙箱模式将在后续版本接入"
                    onClick={() => undefined}
                  >
                    <Box />
                    <span>沙箱</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">即将支持</span>
                  </PickerMenuItem>
                </PopoverContent>
              </Popover>
            </div>

            {isGitProject ? (
              <div className="min-w-0">
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
                    <ScrollArea
                      horizontal={false}
                      className="max-h-56"
                      viewportClassName="max-h-56 flex-none"
                      contentClassName="py-0.5"
                    >
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
                        <p className="px-2 py-5 text-center text-xs text-ui-muted">
                          没有匹配的分支
                        </p>
                      ) : null}
                    </ScrollArea>
                    {canCreateBranch ? (
                      <div className="mt-1 pt-1">
                        <Separator className="mb-1" />
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
                          {creatingBranch ? <Spinner /> : <Plus />}
                          <span className="min-w-0 flex-1 truncate">
                            {"创建并检出 "}
                            {normalizedBranchQuery}
                          </span>
                        </PickerMenuItem>
                      </div>
                    ) : null}
                  </PopoverContent>
                </Popover>
              </div>
            ) : null}
          </div>

          <Composer
            id="new-conversation-composer"
            className="relative -mt-0.5 w-full"
            textareaClassName="min-h-24 max-h-48 pt-4"
            rows={3}
            draft={draft}
            sending={sending}
            models={models}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            modelLabel={modelLabel}
            permissionMode={selectedPermissionMode}
            canSubmit={Boolean(draft.trim() && selectedProject)}
            onDraftChange={onDraftChange}
            onSubmit={onSubmit}
            onSelectModel={onSelectModel}
            onSelectPermissionMode={onSelectPermissionMode}
          />
        </div>
      </div>
    </div>
  )
}
