import { useEffect, useRef, useState } from "react"
import {
  CircleAlert,
  Copy,
  Download,
  Ellipsis,
  LoaderCircle,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@renderer/components/ui/empty"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Switch } from "@renderer/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import type { DesktopPluginInfo, DesktopPluginSnapshot } from "@shared/plugin-types"
import { PluginDetailsDialog } from "../settings-page/plugin-settings"
import { ExtensionIcon } from "./plugin-catalog"
import { pluginTemplates } from "./plugin-templates"
import {
  pluginConfigKey,
  readPluginConfigs,
  savePluginConfigs,
  type PluginConfig,
} from "./plugin-config"
import { PluginEditor } from "./plugin-editor"

interface PluginManagerProps {
  query: string
  addRequest: number
  refreshRequest: number
  projectPath: string
  notify: (message: string) => void
}
const displayName = (plugin: DesktopPluginInfo): string =>
  plugin.identity.displayName ?? plugin.identity.name ?? plugin.identity.id
const needsAttention = (plugin: DesktopPluginInfo): boolean =>
  plugin.installation !== "installed" ||
  plugin.activation === "partial" ||
  plugin.activation === "reload-required" ||
  plugin.permissions.missing.length > 0 ||
  plugin.diagnostics.some((item) => item.severity !== "info") ||
  plugin.toolRuntime?.state === "error" ||
  plugin.toolRuntime?.state === "degraded"
const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error: /,
    ""
  )

export function PluginManager({
  query,
  addRequest,
  refreshRequest,
  projectPath,
  notify,
}: PluginManagerProps): React.JSX.Element {
  const api = window.desktop?.plugins
  const key = pluginConfigKey(projectPath)
  const [initialLocal] = useState(() => {
    try {
      return {
        items: readPluginConfigs(window.localStorage, key),
        raw: window.localStorage.getItem(key),
        error: "",
      }
    } catch (cause) {
      return { items: [] as PluginConfig[], raw: null, error: errorText(cause) }
    }
  })
  const [snapshot, setSnapshot] = useState<DesktopPluginSnapshot | null>(null)
  const [loading, setLoading] = useState(Boolean(api))
  const [busy, setBusy] = useState(Boolean(api))
  const [error, setError] = useState("")
  const [storageError, setStorageError] = useState(initialLocal.error)
  const [configs, setConfigs] = useState<PluginConfig[]>(initialLocal.items)
  const localRaw = useRef(initialLocal.raw)
  const previousRefresh = useRef(refreshRequest)
  const [scope, setScope] = useState("public")
  const [filter, setFilter] = useState("all")
  const [detailId, setDetailId] = useState<string | null>(null)
  const [localDetailId, setLocalDetailId] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{
    id?: string
    initial?: Omit<PluginConfig, "id" | "enabled">
  } | null>(null)
  const [removal, setRemoval] = useState<{ id: string; name: string; local: boolean } | null>(null)
  const lock = useRef(false)
  const loadId = useRef(0)
  const mounted = useRef(true)
  const previousAdd = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!addRequest || addRequest === previousAdd.current) return
    previousAdd.current = addRequest
    setEditor({})
  }, [addRequest])

  useEffect(() => {
    if (refreshRequest === previousRefresh.current) return
    previousRefresh.current = refreshRequest
    try {
      // The explicit refresh request rereads external storage, rather than deriving UI state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfigs(readPluginConfigs(window.localStorage, key))
      localRaw.current = window.localStorage.getItem(key)
      setStorageError("")
    } catch (cause) {
      setStorageError(errorText(cause))
    }
  }, [key, refreshRequest])

  useEffect(() => {
    if (!api) return
    const requestId = ++loadId.current
    let cancelled = false
    lock.current = true
    const request = api.snapshot({ cwd: projectPath })
    void request
      .then((value) => {
        if (!cancelled) setSnapshot(value)
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause))
      })
      .finally(() => {
        if (requestId === loadId.current) lock.current = false
        if (!cancelled) {
          setLoading(false)
          setBusy(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, projectPath])

  useEffect(() => {
    if (!refreshRequest || !api || lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    void api
      .reload({ cwd: projectPath })
      .then((value) => {
        if (mounted.current) {
          setSnapshot(value)
          notify("插件列表已刷新。")
        }
      })
      .catch((cause) => {
        if (mounted.current) setError(errorText(cause))
      })
      .finally(() => {
        lock.current = false
        if (mounted.current) setBusy(false)
      })
  }, [api, projectPath, refreshRequest, notify])

  function persist(next: PluginConfig[], message: string): void {
    if (storageError) throw new Error("本地数据读取失败，请先刷新重试，以免覆盖原始配置。")
    localRaw.current = savePluginConfigs(window.localStorage, key, next, localRaw.current)
    setConfigs(next)
    notify(message)
  }

  async function mutate(plugin: DesktopPluginInfo, uninstall = false): Promise<void> {
    if (!api || lock.current || plugin.scope === "managed") return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      const input = { cwd: projectPath, pluginId: plugin.identity.id }
      const result = await (uninstall
        ? api.uninstall(input)
        : plugin.enabled
          ? api.disable(input)
          : api.enable(input))
      if (!mounted.current) return
      setSnapshot(result)
      if (uninstall) {
        setRemoval(null)
        setDetailId(null)
      }
      notify(`${displayName(plugin)} 已${uninstall ? "卸载" : plugin.enabled ? "禁用" : "启用"}。`)
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function safely(action: () => void): void {
    try {
      action()
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  async function copy(value: unknown): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      notify("插件配置已复制。")
    } catch {
      setError("无法访问剪贴板，请使用导出 JSON 保存配置。")
    }
  }
  function download(config: PluginConfig): void {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(config, null, 2)], { type: "application/json" })
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `${config.name.replace(/[^\p{L}\p{N}._-]/gu, "_")}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = (...values: (string | undefined)[]): boolean =>
    values.join(" ").toLocaleLowerCase().includes(normalizedQuery)
  const plugins = snapshot?.plugins ?? []
  const visiblePlugins = plugins.filter(
    (plugin) =>
      matches(
        displayName(plugin),
        plugin.identity.id,
        plugin.identity.version,
        plugin.sourceFormat
      ) &&
      (filter === "all" || (filter === "enabled" ? plugin.enabled : needsAttention(plugin)))
  )
  const visibleConfigs = configs.filter((config) =>
    matches(config.name, config.description, config.source)
  )
  const detail = plugins.find((plugin) => plugin.identity.id === detailId) ?? null
  const localDetail = configs.find((config) => config.id === localDetailId)
  const template = pluginTemplates.find((item) => item.id === templateId)
  const findRuntime = (name: string): DesktopPluginInfo | undefined =>
    plugins.find((plugin) =>
      [plugin.identity.name, plugin.identity.id, plugin.identity.displayName].some(
        (value) => value?.toLocaleLowerCase() === name.toLocaleLowerCase()
      )
    )
  const requestRemoval = (plugin: DesktopPluginInfo): void =>
    setRemoval({ id: plugin.identity.id, name: displayName(plugin), local: false })

  return (
    <div className="flex flex-col gap-9">
      {error || storageError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error || storageError}</AlertDescription>
        </Alert>
      ) : null}
      {snapshot?.warnings.length ? (
        <Alert>
          <CircleAlert />
          <AlertDescription>{snapshot.warnings.join("；")}</AlertDescription>
        </Alert>
      ) : null}
      <section className="flex flex-col gap-4" aria-labelledby="plugin-installed-title">
        <div className="flex items-center justify-between">
          <h2 id="plugin-installed-title" className="text-sm font-medium">
            已安装
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="管理已安装插件"
            title="管理已安装插件"
            onClick={() => setScope("personal")}
          >
            <Settings2 />
          </Button>
        </div>
        <Separator />
        {loading ? (
          <div className="flex gap-6 py-2" aria-label="正在加载插件">
            {[1, 2, 3, 4].map((id) => (
              <Skeleton key={id} className="size-11 rounded-xl" />
            ))}
          </div>
        ) : plugins.length ? (
          <div className="flex flex-wrap gap-x-5 gap-y-3 py-1">
            {plugins
              .filter((plugin) => matches(displayName(plugin), plugin.identity.id))
              .map((plugin) => (
                <Tooltip key={plugin.identity.id}>
                  <TooltipTrigger
                    className="relative rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`查看 ${displayName(plugin)} 详情`}
                    onClick={() => setDetailId(plugin.identity.id)}
                  >
                    <ExtensionIcon name={displayName(plugin)} />
                    {needsAttention(plugin) ? (
                      <CircleAlert className="absolute -right-1 -bottom-1 size-4 rounded-full bg-background text-destructive" />
                    ) : null}
                  </TooltipTrigger>
                  <TooltipContent>
                    {displayName(plugin)} · {plugin.enabled ? "已启用" : "已禁用"}
                  </TooltipContent>
                </Tooltip>
              ))}
            {normalizedQuery &&
            !plugins.some((plugin) => matches(displayName(plugin), plugin.identity.id)) ? (
              <p className="text-sm text-muted-foreground">没有匹配的已安装插件。</p>
            ) : null}
          </div>
        ) : (
          <p className="py-2 text-sm leading-6 text-muted-foreground">
            {api
              ? "还没有安装插件。你可以从下方选择工具，或添加自己的插件配置。"
              : "当前预览无法读取已安装插件。你仍可浏览模板和管理本地配置。"}
          </p>
        )}
      </section>
      <ToggleGroup
        value={[scope]}
        onValueChange={(value) => value[0] && setScope(value[0])}
        aria-label="插件来源"
        className="w-fit"
      >
        <ToggleGroupItem value="public">公开</ToggleGroupItem>
        <ToggleGroupItem value="personal">个人</ToggleGroupItem>
      </ToggleGroup>

      {visibleConfigs.length ? (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium">已导入插件</h2>
            <span className="text-xs text-muted-foreground">待接入</span>
          </div>
          <Separator />
          <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
            {visibleConfigs.map((config) => (
              <ExtensionRow
                key={config.id}
                name={config.name}
                description={config.description || "尚未填写插件描述"}
                onClick={() => setLocalDetailId(config.id)}
                action={
                  <Button variant="outline" size="sm" onClick={() => setLocalDetailId(config.id)}>
                    管理配置
                  </Button>
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {scope === "public" ? (
        <>
          {(["常用工具", "开发工具"] as const).map((group) => {
            const items = pluginTemplates.filter(
              (item) => item.group === group && matches(item.name, item.description)
            )
            if (!items.length) return null
            return (
              <section key={group} className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">{group}</h2>
                <Separator />
                <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                  {items.map((item) => {
                    const added = configs.find((config) => config.catalogId === item.id)
                    const installed = findRuntime(item.name)
                    const openItem = (): void => {
                      if (installed) setDetailId(installed.identity.id)
                      else if (added) setLocalDetailId(added.id)
                      else setTemplateId(item.id)
                    }
                    return (
                      <ExtensionRow
                        key={item.id}
                        name={item.name}
                        description={item.description}
                        onClick={openItem}
                        action={
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={
                              added
                                ? `管理 ${item.name} 配置`
                                : installed
                                  ? `查看 ${item.name}`
                                  : `添加 ${item.name} 配置`
                            }
                            onClick={openItem}
                          >
                            {added || installed ? <Ellipsis /> : <Plus />}
                          </Button>
                        }
                      />
                    )
                  })}
                </div>
              </section>
            )
          })}
          {normalizedQuery &&
          !pluginTemplates.some((item) => matches(item.name, item.description)) &&
          !visiblePlugins.length &&
          !visibleConfigs.length ? (
            <NoPlugins onAdd={() => setEditor({})} searched />
          ) : null}
        </>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium">我的插件</h2>
            <ToggleGroup
              value={[filter]}
              onValueChange={(value) => value[0] && setFilter(value[0])}
              size="sm"
              aria-label="插件状态"
            >
              <ToggleGroupItem value="all">全部</ToggleGroupItem>
              <ToggleGroupItem value="enabled">已启用</ToggleGroupItem>
              <ToggleGroupItem value="attention">需处理</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <Separator />
          {visiblePlugins.length ? (
            <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
              {visiblePlugins.map((plugin) => (
                <ExtensionRow
                  key={plugin.identity.id}
                  name={displayName(plugin)}
                  description={`${plugin.identity.version} · ${plugin.scope === "managed" ? "由组织管理" : "个人安装"} · ${plugin.enabled ? "已启用" : "已禁用"}`}
                  onClick={() => setDetailId(plugin.identity.id)}
                  action={
                    <div className="flex items-center gap-2">
                      <Switch
                        size="sm"
                        checked={plugin.enabled}
                        disabled={busy || plugin.scope === "managed"}
                        aria-label={`${plugin.enabled ? "禁用" : "启用"} ${displayName(plugin)}`}
                        onCheckedChange={() => void mutate(plugin)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" />}
                          aria-label={`${displayName(plugin)} 更多操作`}
                        >
                          <Ellipsis />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem onClick={() => setDetailId(plugin.identity.id)}>
                              查看详情
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={busy || plugin.scope === "managed"}
                              variant="destructive"
                              onClick={() => requestRemoval(plugin)}
                            >
                              卸载
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  }
                />
              ))}
            </div>
          ) : (
            <NoPlugins
              onAdd={() => setEditor({})}
              searched={Boolean(normalizedQuery) || filter !== "all"}
            />
          )}
        </section>
      )}

      <PluginDetailsDialog
        error={error}
        plugin={detail}
        onOpenChange={(open) => !open && setDetailId(null)}
        actions={
          detail ? (
            <div className="flex items-center justify-between gap-3 py-2">
              <label className="flex items-center gap-3">
                <Switch
                  checked={detail.enabled}
                  disabled={busy || detail.scope === "managed"}
                  onCheckedChange={() => void mutate(detail)}
                />
                {detail.scope === "managed" ? "由组织管理" : detail.enabled ? "已启用" : "已禁用"}
              </label>
              <Button
                variant="destructive"
                disabled={busy || detail.scope === "managed"}
                onClick={() => requestRemoval(detail)}
              >
                <Trash2 data-icon="inline-start" />
                卸载
              </Button>
            </div>
          ) : null
        }
      />

      <Dialog
        open={Boolean(localDetail || template)}
        onOpenChange={(open) => {
          if (!open) {
            setLocalDetailId(null)
            setTemplateId(null)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto p-6 sm:max-w-xl">
          <div className="flex items-start justify-between pr-7">
            <ExtensionIcon name={localDetail?.name ?? template?.name ?? ""} />
            {localDetail ? (
              <Switch
                checked={localDetail.enabled}
                aria-label="启用本地插件配置"
                onCheckedChange={(enabled) =>
                  safely(() =>
                    persist(
                      configs.map((item) =>
                        item.id === localDetail.id ? { ...item, enabled } : item
                      ),
                      enabled ? "配置已启用；运行接入后生效。" : "配置已禁用。"
                    )
                  )
                }
              />
            ) : (
              <Badge variant="secondary">配置模板</Badge>
            )}
          </div>
          <DialogHeader className="mt-2">
            <DialogTitle>{localDetail?.name ?? template?.name}</DialogTitle>
            <DialogDescription>
              {localDetail?.description || template?.description || "自定义插件配置"}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-5 py-5 text-sm">
            <p className="leading-6 text-muted-foreground">
              {localDetail
                ? "此插件配置已保存在本机，尚未安装到运行环境。"
                : "使用此模板记录你希望接入的工具。保存后可继续编辑插件来源。"}
            </p>
            {localDetail ? (
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-3">
                <dt className="text-muted-foreground">来源</dt>
                <dd className="break-all">{localDetail.source || "尚未设置"}</dd>
                <dt className="text-muted-foreground">版本</dt>
                <dd>{localDetail.version}</dd>
                <dt className="text-muted-foreground">状态</dt>
                <dd>本地配置 · 待接入</dd>
              </dl>
            ) : null}
          </div>
          <DialogFooter className="sm:justify-between">
            {localDetail ? (
              <>
                <Button
                  variant="destructive"
                  onClick={() =>
                    setRemoval({ id: localDetail.id, name: localDetail.name, local: true })
                  }
                >
                  移除配置
                </Button>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="复制插件 JSON"
                    title="复制 JSON"
                    onClick={() => void copy(localDetail)}
                  >
                    <Copy />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="导出插件 JSON"
                    title="导出 JSON"
                    onClick={() => download(localDetail)}
                  >
                    <Download />
                  </Button>
                  <Button
                    onClick={() => {
                      setEditor({ id: localDetail.id, initial: localDetail })
                      setLocalDetailId(null)
                    }}
                  >
                    <Pencil data-icon="inline-start" />
                    编辑配置
                  </Button>
                </div>
              </>
            ) : (
              <>
                <span />
                <Button
                  onClick={() => {
                    if (template) {
                      setEditor({
                        initial: {
                          name: template.name,
                          description: template.description,
                          source: "",
                          version: "1.0.0",
                          catalogId: template.id,
                        },
                      })
                      setTemplateId(null)
                    }
                  }}
                >
                  <Plus data-icon="inline-start" />
                  添加配置
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editor ? (
        <PluginEditor
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSave={(value) => {
            if (
              configs.some(
                (item) =>
                  item.id !== editor.id &&
                  item.name.toLocaleLowerCase() === value.name.toLocaleLowerCase()
              )
            )
              throw new Error("已存在同名插件配置，请使用其他名称。")
            const previous = configs.find((item) => item.id === editor.id)
            const next = {
              ...value,
              id: previous?.id ?? crypto.randomUUID(),
              enabled: previous?.enabled ?? true,
            }
            persist(
              previous
                ? configs.map((item) => (item.id === next.id ? next : item))
                : [...configs, next],
              "插件配置已保存到本机，待接入运行环境。"
            )
            setEditor(null)
          }}
        />
      ) : null}

      <AlertDialog
        open={Boolean(removal)}
        onOpenChange={(open) => !open && !busy && setRemoval(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removal?.local ? "移除配置" : "卸载插件"} {removal?.name}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removal?.local
                ? "将删除本机保存的这条插件配置。插件的源文件不会受影响。"
                : "将移除插件安装记录与缓存。本地链接插件的源目录不会被删除。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!removal) return
                if (removal.local)
                  safely(() => {
                    persist(
                      configs.filter((item) => item.id !== removal.id),
                      "插件配置已移除。"
                    )
                    setRemoval(null)
                    setLocalDetailId(null)
                  })
                else {
                  const plugin = plugins.find((item) => item.identity.id === removal.id)
                  if (plugin) void mutate(plugin, true)
                }
              }}
            >
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}确认
              {removal?.local ? "移除" : "卸载"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ExtensionRow({
  name,
  description,
  onClick,
  action,
}: {
  name: string
  description: string
  onClick: () => void
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-extension-row
      className="group flex min-h-20 min-w-0 items-center gap-3 rounded-xl px-1 py-3"
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClick}
      >
        <ExtensionIcon name={name} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-semibold group-hover:underline group-hover:underline-offset-4">
            {name}
          </span>
          <span className="truncate text-sm text-muted-foreground" title={description}>
            {description}
          </span>
        </span>
      </button>
      {action}
    </div>
  )
}
function NoPlugins({
  onAdd,
  searched,
}: {
  onAdd: () => void
  searched?: boolean
}): React.JSX.Element {
  return (
    <Empty className="py-8">
      <EmptyHeader>
        <EmptyTitle>{searched ? "没有找到匹配的插件" : "还没有安装插件"}</EmptyTitle>
        <EmptyDescription>
          {searched ? "试试其他关键词或切换筛选条件。" : "添加插件配置，开始整理你的工具。"}
        </EmptyDescription>
      </EmptyHeader>
      {!searched ? (
        <Button variant="outline" onClick={onAdd}>
          <Plus data-icon="inline-start" />
          添加配置
        </Button>
      ) : null}
    </Empty>
  )
}
