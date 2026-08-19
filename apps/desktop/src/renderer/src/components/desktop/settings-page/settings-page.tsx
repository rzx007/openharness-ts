import {
  ArrowLeft,
  ChevronDown,
  Code2,
  MonitorCog,
  Search,
  SlidersHorizontal,
  TerminalSquare,
} from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card"
import { Input } from "@renderer/components/ui/input"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Separator } from "@renderer/components/ui/separator"
import { Switch } from "@renderer/components/ui/switch"
import { cn } from "@renderer/lib/utils"
import { ProviderSettings } from "./provider-settings"
import {
  codingSettingsNavigation,
  integrationSettingsNavigation,
  personalSettingsNavigation,
  type SettingsNavigationItem,
} from "./settings-navigation"

type SettingsSidebarProps = {
  onClose: () => void
  selectedSection: string
  onSelectSection: (section: string) => void
}

type SettingsContentProps = {
  selectedSection: string
}

export function SettingsSidebar({
  onClose,
  selectedSection,
  onSelectSection,
}: SettingsSidebarProps): React.JSX.Element {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-transparent px-3 py-3 text-sidebar-foreground">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="mb-4 w-fit text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <ArrowLeft data-icon="inline-start" />
        返回应用
      </Button>

      <div className="relative mb-5">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="搜索设置"
          placeholder="搜索设置..."
          className="h-9 rounded-full bg-background pl-9 shadow-none"
        />
      </div>

      <ScrollArea horizontal={false} className="min-h-0 flex-1">
        <SettingsNavigationGroup
          label="个人"
          items={personalSettingsNavigation}
          selectedSection={selectedSection}
          onSelect={onSelectSection}
        />
        <SettingsNavigationGroup
          label="集成"
          items={integrationSettingsNavigation}
          selectedSection={selectedSection}
          onSelect={onSelectSection}
        />
        <SettingsNavigationGroup
          label="编码"
          items={codingSettingsNavigation}
          selectedSection={selectedSection}
          onSelect={onSelectSection}
        />
      </ScrollArea>

      <div className="flex items-center gap-2 border-t border-sidebar-border px-2 pt-3">
        <span className="grid size-7 place-items-center rounded-full bg-amber-400 text-[10px] font-semibold text-amber-950">
          OH
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">OpenHarness</p>
          <p className="truncate text-[11px] text-sidebar-muted">本地工作区</p>
        </div>
      </div>
    </aside>
  )
}

export function SettingsContent({ selectedSection }: SettingsContentProps): React.JSX.Element {
  return (
    <ScrollArea horizontal={false} className="h-full min-w-0 flex-1 bg-conversation">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-10 py-16 lg:px-16">
        <header className="flex flex-col gap-2">
          <h1 className="font-heading text-xl tracking-tight">{selectedSection}</h1>
          <p className="text-sm text-muted-foreground">
            {selectedSection === "常规"
              ? "调整 OpenHarness 的默认工作方式。当前页面仅展示静态效果，暂不会写入配置。"
              : selectedSection === "供应商"
                ? "连接模型服务和开发工具订阅，选择 OpenHarness 默认使用的供应商。"
                : `${selectedSection}页面将在后续迭代中接入。`}
          </p>
        </header>

        {selectedSection === "常规" ? (
          <GeneralSettings />
        ) : selectedSection === "供应商" ? (
          <ProviderSettings />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{selectedSection}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <SlidersHorizontal className="size-8" strokeWidth={1.5} />
                <p className="text-sm">这一页先保留导航与布局，具体设置项后续再补。</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  )
}

function GeneralSettings(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10">
      <SettingsSection title="权限">
        <SettingRow
          title="默认权限"
          description="允许智能体读取和编辑当前工作区中的文件；需要访问工作区之外的位置时再向你请求。"
          control={<Switch aria-label="默认权限" defaultChecked />}
        />
        <Separator />
        <SettingRow
          title="自动审核"
          description="在执行工具之前自动判断风险，遇到敏感操作仍会请求你的确认。"
          control={<Switch aria-label="自动审核" defaultChecked />}
        />
        <Separator />
        <SettingRow
          title="完整访问权限"
          description="允许智能体在无需逐次批准的情况下访问工作区外的文件和网络。"
          control={<Switch aria-label="完整访问权限" />}
        />
      </SettingsSection>

      <SettingsSection title="常规">
        <SettingRow
          title="默认文件打开目标"
          description="选择打开代码文件和文件夹时使用的应用"
          control={<SettingSelect icon={<Code2 />} label="VS Code" />}
        />
        <Separator />
        <SettingRow
          title="运行环境"
          description="选择智能体在 Windows 上运行命令的位置"
          control={<SettingSelect icon={<MonitorCog />} label="Windows 原生" />}
        />
        <Separator />
        <SettingRow
          title="集成终端 Shell"
          description="选择新终端默认打开的 Shell"
          control={<SettingSelect icon={<TerminalSquare />} label="PowerShell" />}
        />
        <Separator />
        <SettingRow
          title="界面语言"
          description="OpenHarness 桌面应用使用的语言"
          control={<SettingSelect label="简体中文" />}
        />
        <Separator />
        <SettingRow
          title="桌面宠物"
          description="启动应用时显示桌面宠物"
          control={<Switch aria-label="桌面宠物" defaultChecked />}
        />
        <Separator />
        <SettingRow
          title="运行速度"
          description="选择智能体执行任务时的默认速度"
          control={<SettingSelect label="标准" />}
        />
        <Separator />
        <SettingRow
          title="提示词建议"
          description="根据当前项目和对话内容建议下一步操作"
          control={<Switch aria-label="提示词建议" />}
        />
        <Separator />
        <SettingRow
          title="导入设置"
          description="从已有的 OpenHarness 配置中恢复偏好"
          control={
            <Button variant="secondary" size="sm">
              再次导入
            </Button>
          }
        />
        <Separator />
        <SettingRow
          title="关于 OpenHarness"
          description="版本 1.0.0"
          control={
            <Button variant="ghost" size="sm">
              查看详情
            </Button>
          }
        />
      </SettingsSection>
    </div>
  )
}

function SettingsSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4" aria-labelledby={`settings-${title}`}>
      <h2 id={`settings-${title}`} className="font-heading text-lg font-semibold">
        {title}
      </h2>
      <Card className="py-0">
        <CardHeader className="sr-only">
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="px-5">{children}</CardContent>
      </Card>
    </section>
  )
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string
  description: string
  control: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-20 items-center gap-6 py-4">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

function SettingSelect({
  icon,
  label,
}: {
  icon?: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <Button type="button" variant="outline" size="sm" className="min-w-28 justify-between">
      {icon}
      <span>{label}</span>
      <ChevronDown data-icon="inline-end" />
    </Button>
  )
}

function SettingsNavigationGroup({
  label,
  items,
  selectedSection,
  onSelect,
}: {
  label: string
  items: SettingsNavigationItem[]
  selectedSection: string
  onSelect: (label: string) => void
}): React.JSX.Element {
  return (
    <nav className="mb-5" aria-label={`${label}设置`}>
      <p className="px-2 pb-1.5 text-xs text-sidebar-muted/70">{label}</p>
      <div className="flex flex-col gap-0.5">
        {items.map(({ label: itemLabel, icon: Icon }) => (
          <button
            key={itemLabel}
            type="button"
            aria-current={selectedSection === itemLabel ? "page" : undefined}
            onClick={() => onSelect(itemLabel)}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              selectedSection === itemLabel
                ? "bg-sidebar-selected font-medium text-sidebar-foreground"
                : "text-sidebar-foreground/82 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            )}
          >
            <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
            {itemLabel}
          </button>
        ))}
      </div>
    </nav>
  )
}
