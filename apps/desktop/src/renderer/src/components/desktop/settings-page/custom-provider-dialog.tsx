import { LoaderCircle, Plus, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Separator } from "@renderer/components/ui/separator"
import type { DesktopCustomProviderInput, DesktopProviderInfo } from "@shared/provider-types"
import {
  type CustomProviderFormState,
  validateCustomProviderForm,
} from "./custom-provider-form"

interface CustomProviderDialogProps {
  open: boolean
  provider?: DesktopProviderInfo
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (value: DesktopCustomProviderInput, setActive: boolean) => void
}

export function CustomProviderDialog({
  open,
  provider,
  busy,
  onOpenChange,
  onSubmit,
}: CustomProviderDialogProps): React.JSX.Element {
  const nextRowId = useRef(1)
  const [form, setForm] = useState<CustomProviderFormState>(() => initialForm(provider))
  const [setActive, setSetActive] = useState(true)
  const [invalid, setInvalid] = useState<{ field: string; message: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(initialForm(provider))
    setSetActive(provider ? false : true)
    setInvalid(null)
  }, [open, provider])

  const rowKey = (prefix: string): string => `${prefix}-${nextRowId.current++}`
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const result = validateCustomProviderForm(form)
    if (!result.ok) {
      setInvalid({ field: result.field, message: result.message })
      return
    }
    setInvalid(null)
    onSubmit(result.value, setActive)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{provider ? `编辑 ${provider.displayName}` : "添加自定义供应商"}</DialogTitle>
            <DialogDescription>
              配置 OpenAI 兼容接口。API 密钥单独保存在本地凭证中，普通设置只保存连接信息。
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field data-invalid={invalid?.field === "id" || undefined}>
              <FieldLabel htmlFor="custom-provider-id">供应商 ID</FieldLabel>
              <Input
                id="custom-provider-id"
                value={form.id}
                disabled={Boolean(provider)}
                aria-invalid={invalid?.field === "id" || undefined}
                onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))}
                placeholder="my-provider"
              />
              <FieldDescription>
                {invalid?.field === "id"
                  ? invalid.message
                  : "使用小写字母、数字、连字符或下划线；创建后不能修改。"}
              </FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={invalid?.field === "displayName" || undefined}>
                <FieldLabel htmlFor="custom-provider-name">显示名称</FieldLabel>
                <Input
                  id="custom-provider-name"
                  value={form.displayName}
                  aria-invalid={invalid?.field === "displayName" || undefined}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                  placeholder="我的 AI 供应商"
                />
              </Field>
              <Field data-invalid={invalid?.field === "baseUrl" || undefined}>
                <FieldLabel htmlFor="custom-provider-url">基础 URL</FieldLabel>
                <Input
                  id="custom-provider-url"
                  value={form.baseUrl}
                  aria-invalid={invalid?.field === "baseUrl" || undefined}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  placeholder="https://api.example.com/v1"
                />
                {invalid?.field === "baseUrl" ? (
                  <FieldDescription>{invalid.message}</FieldDescription>
                ) : null}
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="custom-provider-key">API 密钥（可选）</FieldLabel>
              <Input
                id="custom-provider-key"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={provider ? "留空则保留现有密钥" : "本地服务可留空"}
              />
              <FieldDescription>适用于 Ollama 等无认证的本地接口时可以留空。</FieldDescription>
            </Field>

            <Separator />

            <FieldSet data-invalid={invalid?.field === "models" || undefined}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <FieldLegend>模型</FieldLegend>
                  <FieldDescription>
                    {invalid?.field === "models" ? invalid.message : "至少添加一个可用模型。"}
                  </FieldDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      models: [
                        ...current.models,
                        { key: rowKey("model"), id: "", displayName: "" },
                      ],
                    }))
                  }
                >
                  <Plus data-icon="inline-start" />
                  添加模型
                </Button>
              </div>
              <div className="flex flex-col gap-3">
                {form.models.map((model, index) => (
                  <div key={model.key} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <Input
                      value={model.id}
                      aria-label={`模型 ${index + 1} ID`}
                      aria-invalid={invalid?.field === "models" || undefined}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          models: current.models.map((item) =>
                            item.key === model.key ? { ...item, id: event.target.value } : item
                          ),
                        }))
                      }
                      placeholder="model-id"
                    />
                    <Input
                      value={model.displayName}
                      aria-label={`模型 ${index + 1} 显示名称`}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          models: current.models.map((item) =>
                            item.key === model.key
                              ? { ...item, displayName: event.target.value }
                              : item
                          ),
                        }))
                      }
                      placeholder="显示名称（可选）"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除模型 ${index + 1}`}
                      disabled={form.models.length === 1}
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          models: current.models.filter((item) => item.key !== model.key),
                        }))
                      }
                    >
                      <Trash2 data-icon="inline-start" />
                    </Button>
                  </div>
                ))}
              </div>
            </FieldSet>

            <Separator />

            <FieldSet data-invalid={invalid?.field === "headers" || undefined}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <FieldLegend>请求头（可选）</FieldLegend>
                  <FieldDescription>
                    {invalid?.field === "headers" ? invalid.message : "用于租户或网关路由信息。"}
                  </FieldDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      headers: [
                        ...current.headers,
                        { key: rowKey("header"), name: "", value: "" },
                      ],
                    }))
                  }
                >
                  <Plus data-icon="inline-start" />
                  添加请求头
                </Button>
              </div>
              {form.headers.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {form.headers.map((header, index) => (
                    <div key={header.key} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                      <Input
                        value={header.name}
                        aria-label={`请求头 ${index + 1} 名称`}
                        aria-invalid={invalid?.field === "headers" || undefined}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            headers: current.headers.map((item) =>
                              item.key === header.key ? { ...item, name: event.target.value } : item
                            ),
                          }))
                        }
                        placeholder="Header-Name"
                      />
                      <Input
                        value={header.value}
                        aria-label={`请求头 ${index + 1} 值`}
                        aria-invalid={invalid?.field === "headers" || undefined}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            headers: current.headers.map((item) =>
                              item.key === header.key ? { ...item, value: event.target.value } : item
                            ),
                          }))
                        }
                        placeholder="value"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除请求头 ${index + 1}`}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            headers: current.headers.filter((item) => item.key !== header.key),
                          }))
                        }
                      >
                        <Trash2 data-icon="inline-start" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </FieldSet>

            {!provider ? (
              <Field orientation="horizontal">
                <Checkbox
                  id="custom-provider-active"
                  checked={setActive}
                  onCheckedChange={(checked) => setSetActive(checked === true)}
                />
                <FieldLabel htmlFor="custom-provider-active">保存后设为当前供应商</FieldLabel>
              </Field>
            ) : null}
          </FieldGroup>

          <DialogFooter>
            <DialogClose render={<Button variant="outline">取消</Button>} />
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
              {busy ? "保存中..." : provider ? "保存修改" : "添加供应商"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function initialForm(provider?: DesktopProviderInfo): CustomProviderFormState {
  return {
    id: provider?.name ?? "",
    displayName: provider?.displayName ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    models: provider?.models.length
      ? provider.models.map((model, index) => ({
          key: `model-${index}`,
          id: model.id,
          displayName: model.label,
        }))
      : [{ key: "model-0", id: "", displayName: "" }],
    headers: Object.entries(provider?.headers ?? {}).map(([name, value], index) => ({
      key: `header-${index}`,
      name,
      value,
    })),
  }
}
