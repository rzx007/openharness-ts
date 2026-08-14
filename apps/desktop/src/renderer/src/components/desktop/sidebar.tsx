import {
  Bell,
  Bot,
  ChevronDown,
  CircleDot,
  Clock3,
  Folder,
  GitPullRequest,
  Grid2X2,
  MessageSquarePlus,
  PlugZap,
  Search,
} from "lucide-react"

import { cn } from "@renderer/lib/utils"
import { ScrollArea } from "@renderer/components/ui/scroll-area"

type SidebarProps = {
  open: boolean
}

const primaryNavigation = [
  { icon: MessageSquarePlus, label: "新对话" },
  { icon: GitPullRequest, label: "拉取请求" },
  { icon: Grid2X2, label: "站点" },
  { icon: Clock3, label: "已安排" },
  { icon: PlugZap, label: "插件" },
]

const projects = [
  {
    name: "digital-employe-client-web-main",
    threads: [
      "规划离线 Docker Agent 后端 (2)",
      "规划离线 Docker Agent 后端 (3)",
      "规划离线 Docker Agent 后端",
      "添加 Node 测试生成脚本",
      "分析技能凭证解析逻辑",
    ],
  },
  {
    name: "OpenHarness-ts",
    threads: ["复刻 Codex 桌面工作台", "搭建桌面应用基础模板"],
  },
  { name: "hermes-agent-ts", threads: [] },
]

const recentThreads = [
  "创建一个名为“工作日晨间简报”的定时任务",
  "当前分支又 feedback 相关逻辑吗",
  "你能生成图片吗",
]

export function Sidebar({ open }: SidebarProps): React.JSX.Element {
  const notify = (): void => {
    void window.desktop.tray.notify({
      title: "OpenHarness",
      body: "通知中心已连接。",
      showWhenFocused: true,
    })
  }

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-transparent",
        !open && "pointer-events-none"
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-4 pt-2 pb-2">
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-md px-1.5 text-[15px] font-semibold hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          OpenHarness
          <ChevronDown className="size-3.5 text-sidebar-muted" />
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <SidebarIconButton label="搜索">
            <Search />
          </SidebarIconButton>
          <SidebarIconButton label="通知" onClick={notify}>
            <Bell />
          </SidebarIconButton>
        </div>
      </div>

      <nav className="min-w-0 px-2" aria-label="主要导航">
        {primaryNavigation.map(({ icon: Icon, label }) => (
          <button
            key={label}
            type="button"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-[450] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportClassName="px-2 pt-4"
        contentClassName="pb-4"
      >
        <SidebarSectionLabel>项目</SidebarSectionLabel>
        <div className="space-y-2">
          {projects.map((project) => (
            <ProjectGroup key={project.name} {...project} />
          ))}
        </div>

        <SidebarSectionLabel className="mt-5">最近</SidebarSectionLabel>
        <div>
          {recentThreads.map((thread) => (
            <button
              key={thread}
              type="button"
              className="block h-8 w-full truncate rounded-md px-2.5 text-left text-[12.5px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {thread}
            </button>
          ))}
        </div>
      </ScrollArea>

      <div className="min-w-0 border-t border-sidebar-border px-2 py-2">
        <button
          type="button"
          className="flex h-11 w-full items-center rounded-xl bg-background px-3 text-left shadow-sm ring-1 ring-black/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <CircleDot className="mr-2 size-4 text-sidebar-muted" />
          <span className="text-[13px] font-medium">开始使用</span>
          <span className="ml-auto text-xs text-sidebar-muted">1/3</span>
        </button>
      </div>

      <div className="flex min-w-0 items-center border-t border-sidebar-border px-4 py-3">
        <span className="grid size-6 place-items-center rounded-full bg-amber-400 text-[10px] font-semibold text-amber-950">
          OH
        </span>
        <span className="ml-2 text-[13px] font-medium">OpenHarness</span>
        <button
          type="button"
          title="桌面宠物"
          aria-label="显示桌面宠物"
          onClick={() => void window.desktop.pet.show()}
          className="ml-auto grid size-7 place-items-center rounded-full bg-orange-500/15 text-orange-700 transition-colors hover:bg-orange-500/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5"
        >
          <Bot />
        </button>
      </div>
    </aside>
  )
}

function ProjectGroup({ name, threads }: { name: string; threads: string[] }): React.JSX.Element {
  return (
    <section>
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] font-[450] text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Folder className="size-4 text-sidebar-muted" strokeWidth={1.8} />
        <span className="truncate">{name}</span>
      </button>
      {threads.length > 0 && (
        <div className="mt-0.5">
          {threads.map((thread, index) => (
            <button
              key={thread}
              type="button"
              className={cn(
                "block h-8 w-full truncate rounded-md pr-2 pl-8 text-left text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                name === "OpenHarness-ts" && index === 0
                  ? "bg-sidebar-selected font-[450] text-sidebar-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent"
              )}
            >
              {thread}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function SidebarSectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn("px-2.5 pb-2 text-xs font-medium text-sidebar-muted", className)}>
      {children}
    </div>
  )
}

function SidebarIconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4"
    >
      {children}
    </button>
  )
}
