import {
  CheckCircle2,
  CircleAlert,
  CircleCheck,
  Cloud,
  Link2,
  LoaderCircle,
  RefreshCw,
  Server,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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
import { Alert, AlertAction, AlertDescription } from "@renderer/components/ui/alert"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card"
import { Checkbox } from "@renderer/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip"
import { cn } from "@renderer/lib/utils"
import type {
  DesktopProviderCredentialSource,
  DesktopProviderInfo,
  DesktopProviderSnapshot,
} from "@shared/provider-types"
import { scheduleProviderNoticeDismissal } from "./provider-feedback"

const popularProviderNames = [
  "openai",
  "anthropic",
  "deepseek",
  "openrouter",
  "gemini",
  "dashscope",
]

const providerDescriptions: Record<string, string> = {
  openai: "GPT 系列模型",
  anthropic: "Claude 系列模型",
  deepseek: "DeepSeek 对话与推理模型",
  openrouter: "通过一个 API 使用多个模型",
  gemini: "Google Gemini 系列模型",
  dashscope: "阿里云百炼与通义千问模型",
  moonshot: "Moonshot 与 Kimi 系列模型",
  minimax: "MiniMax 系列模型",
  zhipu: "智谱 GLM 系列模型",
  groq: "Groq 高速推理服务",
  mistral: "Mistral 与 Codestral 模型",
  ollama: "本机运行的 Ollama 模型",
  vllm: "本机或局域网中的 vLLM 服务",
}

export function ProviderSettings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopProviderSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [connectTarget, setConnectTarget] = useState<DesktopProviderInfo | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<DesktopProviderInfo | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [setActiveAfterConnect, setSetActiveAfterConnect] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const mutationInFlight = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    setMessage(null)
    try {
      setSnapshot(await window.desktop.providers.snapshot())
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.desktop.providers
      .snapshot()
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!message) return
    return scheduleProviderNoticeDismissal(() => setMessage(null), 4_000)
  }, [message])

  useEffect(() => {
    if (!error) return
    return scheduleProviderNoticeDismissal(() => setError(null), 6_000)
  }, [error])

  const connectedProviders = useMemo(
    () => snapshot?.providers.filter((provider) => provider.connected) ?? [],
    [snapshot]
  )
  const availableProviders = useMemo(() => {
    const providers =
      snapshot?.providers.filter((provider) => !provider.connected && provider.name !== "codex") ??
      []
    return [...providers].sort((left, right) => {
      const leftIndex = popularProviderNames.indexOf(left.name)
      const rightIndex = popularProviderNames.indexOf(right.name)
      if (leftIndex === -1 && rightIndex === -1) {
        return left.displayName.localeCompare(right.displayName)
      }
      if (leftIndex === -1) return 1
      if (rightIndex === -1) return -1
      return leftIndex - rightIndex
    })
  }, [snapshot])
  const visibleAvailableProviders = showAll
    ? availableProviders
    : availableProviders.slice(0, popularProviderNames.length)
  const activeProvider = snapshot?.providers.find((provider) => provider.active)

  const runMutation = async (
    providerName: string,
    operation: () => Promise<DesktopProviderSnapshot>,
    successMessage: string
  ): Promise<boolean> => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    setBusyProvider(providerName)
    setError(null)
    setMessage(null)
    try {
      setSnapshot(await operation())
      setMessage(successMessage)
      return true
    } catch (mutationError) {
      setError(errorMessage(mutationError))
      return false
    } finally {
      mutationInFlight.current = false
      setBusyProvider(null)
    }
  }

  const activate = (provider: DesktopProviderInfo): void => {
    void runMutation(
      provider.name,
      () => window.desktop.providers.activate({ provider: provider.name }),
      `已将 ${provider.displayName} 设为当前供应商。`
    )
  }

  const connect = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!connectTarget || !apiKey.trim() || busyProvider) return
    const target = connectTarget
    void runMutation(
      target.name,
      () =>
        window.desktop.providers.connect({
          provider: target.name,
          apiKey,
          setActive: setActiveAfterConnect,
        }),
      `已连接 ${target.displayName}。`
    ).then((succeeded) => {
      if (!succeeded) return
      setConnectTarget(null)
      setApiKey("")
    })
  }

  const disconnect = (): void => {
    if (!disconnectTarget || busyProvider) return
    const target = disconnectTarget
    void runMutation(
      target.name,
      () => window.desktop.providers.disconnect({ provider: target.name }),
      `已断开 ${target.displayName}。`
    ).then((succeeded) => succeeded && setDisconnectTarget(null))
  }

  if (loading && !snapshot) return <ProviderSettingsSkeleton />

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <Alert variant="destructive" aria-live="assertive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="关闭错误提示"
              onClick={() => setError(null)}
            >
              <X data-icon="inline-start" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {message ? (
        <Alert role="status" aria-live="polite">
          <CircleCheck />
          <AlertDescription>{message}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="关闭成功提示"
              onClick={() => setMessage(null)}
            >
              <X data-icon="inline-start" />
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <CurrentProviderCard provider={activeProvider} activeModel={snapshot?.activeModel} />

      <section className="flex flex-col gap-4" aria-labelledby="provider-heading">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="provider-heading" className="font-heading text-base tracking-tight">
              供应商
            </h2>
            <p className="text-xs leading-5 text-muted-foreground">
              统一管理 API 密钥、本地服务和自动检测到的开发工具订阅。
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="重新检测供应商"
                  disabled={loading}
                  onClick={() => void load()}
                />
              }
            >
              <RefreshCw data-icon="inline-start" className={cn(loading && "animate-spin")} />
            </TooltipTrigger>
            <TooltipContent>重新检测供应商</TooltipContent>
          </Tooltip>
        </div>
        <ProviderListCard
          connectedProviders={connectedProviders}
          availableProviders={visibleAvailableProviders}
          totalAvailableProviders={availableProviders.length}
          expanded={showAll}
          busyProvider={busyProvider}
          onToggleExpanded={() => setShowAll((value) => !value)}
          onActivate={activate}
          onConnect={setConnectTarget}
          onDisconnect={setDisconnectTarget}
        />
      </section>

      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>自定义供应商</CardTitle>
          <CardDescription>连接 OpenAI 兼容接口，并自定义模型与请求头。</CardDescription>
          <CardAction>
            <Button type="button" variant="outline" size="sm" disabled>
              即将支持
            </Button>
          </CardAction>
        </CardHeader>
      </Card>

      <Dialog
        open={connectTarget !== null}
        onOpenChange={(open) => {
          if (open || busyProvider) return
          setConnectTarget(null)
          setApiKey("")
        }}
      >
        <DialogContent>
          <form onSubmit={connect} className="contents">
            <DialogHeader>
              <DialogTitle>连接 {connectTarget?.displayName}</DialogTitle>
              <DialogDescription>
                API 密钥会由 OpenHarness 认证服务保存到本地凭证文件，不会写入普通设置。
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="provider-api-key">API 密钥</FieldLabel>
                <Input
                  id="provider-api-key"
                  type="password"
                  autoFocus
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="输入 API 密钥"
                />
                <FieldDescription>保存后页面只显示凭证来源，不会再次读取密钥。</FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="provider-set-active"
                  checked={setActiveAfterConnect}
                  onCheckedChange={(checked) => setSetActiveAfterConnect(checked === true)}
                />
                <FieldLabel htmlFor="provider-set-active">连接后设为当前供应商</FieldLabel>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">取消</Button>} />
              <Button type="submit" disabled={!apiKey.trim() || busyProvider !== null}>
                {busyProvider ? (
                  <LoaderCircle data-icon="inline-start" className="animate-spin" />
                ) : null}
                {busyProvider ? "连接中..." : "连接"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => !open && !busyProvider && setDisconnectTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>断开 {disconnectTarget?.displayName}？</AlertDialogTitle>
            <AlertDialogDescription>
              这会删除 OpenHarness 保存的该供应商凭证，不会影响供应商网站上的账户或订阅。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyProvider !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyProvider !== null}
              onClick={disconnect}
            >
              {busyProvider ? "断开中..." : "断开连接"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CurrentProviderCard({
  provider,
  activeModel,
}: {
  provider?: DesktopProviderInfo
  activeModel?: string
}): React.JSX.Element {
  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b bg-muted/30">
        <CardTitle>当前供应商</CardTitle>
        <CardDescription>新会话默认使用的模型服务与认证来源。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-4">
          <ProviderIcon provider={provider} emphasized />
          <div className="min-w-0">
            <p className="truncate font-heading text-base font-semibold">
              {provider?.displayName ?? "尚未选择供应商"}
            </p>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {activeModel ?? "未选择默认模型"}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {provider
                ? sourceLabel(provider.credentialSource, provider.credentialLabel)
                : "连接供应商后即可开始使用"}
            </p>
          </div>
        </div>
        {provider?.connected ? (
          <Badge variant="secondary">正在使用</Badge>
        ) : provider ? (
          <Badge variant="destructive">认证不可用</Badge>
        ) : (
          <Badge variant="outline">未配置</Badge>
        )}
      </CardContent>
    </Card>
  )
}

function ProviderListCard({
  connectedProviders,
  availableProviders,
  totalAvailableProviders,
  expanded,
  busyProvider,
  onToggleExpanded,
  onActivate,
  onConnect,
  onDisconnect,
}: {
  connectedProviders: DesktopProviderInfo[]
  availableProviders: DesktopProviderInfo[]
  totalAvailableProviders: number
  expanded: boolean
  busyProvider: string | null
  onToggleExpanded: () => void
  onActivate: (provider: DesktopProviderInfo) => void
  onConnect: (provider: DesktopProviderInfo) => void
  onDisconnect: (provider: DesktopProviderInfo) => void
}): React.JSX.Element {
  return (
    <Card className="py-0 shadow-xs">
      <CardHeader className="sr-only">
        <CardTitle>供应商列表</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <ProviderGroup
          label="已连接"
          description="凭证仅显示来源，不会在页面中返回密钥内容。"
          providers={connectedProviders}
          emptyText="还没有检测到已连接的供应商。"
          busyProvider={busyProvider}
          onActivate={onActivate}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
        <Separator />
        <ProviderGroup
          label="可连接"
          description="选择模型服务并保存 API 密钥。"
          providers={availableProviders}
          emptyText="所有内置供应商都已连接。"
          busyProvider={busyProvider}
          onActivate={onActivate}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
        {totalAvailableProviders > popularProviderNames.length ? (
          <>
            <Separator />
            <div className="flex justify-center px-6 py-3">
              <Button type="button" variant="ghost" size="sm" onClick={onToggleExpanded}>
                {expanded ? "收起供应商" : `查看全部 ${totalAvailableProviders} 个供应商`}
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ProviderGroup({
  label,
  description,
  providers,
  emptyText,
  busyProvider,
  onActivate,
  onConnect,
  onDisconnect,
}: {
  label: string
  description: string
  providers: DesktopProviderInfo[]
  emptyText: string
  busyProvider: string | null
  onActivate: (provider: DesktopProviderInfo) => void
  onConnect: (provider: DesktopProviderInfo) => void
  onDisconnect: (provider: DesktopProviderInfo) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-end justify-between gap-4 bg-muted/20 px-6 py-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-sm font-semibold">{label}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline">{providers.length}</Badge>
      </div>
      <div className="px-6">
        {providers.length === 0 ? (
          <p className="py-7 text-center text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          providers.map((provider, index) => (
            <div key={provider.name}>
              {index > 0 ? <Separator /> : null}
              <ProviderRow
                provider={provider}
                busy={busyProvider === provider.name}
                locked={busyProvider !== null}
                onActivate={() => onActivate(provider)}
                onConnect={() => onConnect(provider)}
                onDisconnect={() => onDisconnect(provider)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ProviderRow({
  provider,
  busy,
  locked,
  onActivate,
  onConnect,
  onDisconnect,
}: {
  provider: DesktopProviderInfo
  busy: boolean
  locked: boolean
  onActivate: () => void
  onConnect: () => void
  onDisconnect: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-24 flex-col items-stretch gap-4 py-5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <ProviderIcon provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-sm font-semibold">{provider.displayName}</h3>
            {provider.connected ? (
              <Badge variant="outline">
                {sourceLabel(provider.credentialSource, provider.credentialLabel)}
              </Badge>
            ) : null}
            {provider.active ? (
              <Badge variant={provider.connected ? "secondary" : "destructive"}>
                {provider.connected ? "正在使用" : "认证不可用"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {provider.currentModel ??
              providerDescriptions[provider.name] ??
              "OpenHarness 内置供应商"}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        {provider.active && provider.connected ? (
          <Button type="button" size="sm" variant="ghost" disabled>
            <CheckCircle2 data-icon="inline-start" />
            当前
          </Button>
        ) : provider.connected ? (
          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={onActivate}>
            {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {busy ? "切换中..." : "设为当前"}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" disabled={locked} onClick={onConnect}>
            <Link2 data-icon="inline-start" />
            {provider.active ? "重新连接" : "连接"}
          </Button>
        )}
        {provider.credentialSource === "credentials" && !provider.active ? (
          <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={onDisconnect}>
            断开
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function ProviderIcon({
  provider,
  emphasized = false,
}: {
  provider?: DesktopProviderInfo
  emphasized?: boolean
}): React.JSX.Element {
  const icon = !provider ? (
    <Cloud />
  ) : provider.credentialSource === "subscription" ? (
    <TerminalSquare />
  ) : provider.local ? (
    <Server />
  ) : (
    <Sparkles />
  )

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground ring-1 ring-foreground/10",
        emphasized ? "size-12 shadow-xs [&_svg]:size-5" : "size-10 [&_svg]:size-4"
      )}
    >
      {icon}
    </span>
  )
}

function ProviderSettingsSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8" aria-label="正在加载供应商">
      <Skeleton className="h-36 w-full rounded-xl" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  )
}

function sourceLabel(source: DesktopProviderCredentialSource, label?: string): string {
  if (source === "credentials") return label ?? "API 密钥"
  if (source === "environment") return label ? `环境变量 · ${label}` : "环境变量"
  if (source === "subscription") return label ? `开发工具订阅 · ${label}` : "开发工具订阅"
  if (source === "local") return "本地服务"
  if (source === "configured") return label ?? "已配置"
  return "未连接"
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes("Cannot update authentication while session runs are active")) {
    return "当前有任务正在运行。请等待任务结束或停止任务后，再修改供应商认证。"
  }
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, "")
}
