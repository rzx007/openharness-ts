import { useId } from "react"
import { Plus, X } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@renderer/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import type { McpForm, McpPairs } from "./mcp-config"

function StringRows({
  label,
  values,
  onChange,
  description,
  errorId,
  invalid,
}: {
  label: string
  values: string[]
  onChange: (values: string[]) => void
  description?: string
  errorId?: string
  invalid?: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldGroup className="gap-2">
        {values.map((value, index) => (
          <Field key={index} orientation="horizontal" data-invalid={invalid}>
            <FieldLabel className="sr-only" htmlFor={`${id}-${index}`}>
              {label} {index + 1}
            </FieldLabel>
            <Input
              id={`${id}-${index}`}
              value={value}
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`移除${label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </Field>
        ))}
      </FieldGroup>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onChange([...values, ""])}
      >
        <Plus data-icon="inline-start" />
        添加{label}
      </Button>
    </FieldSet>
  )
}

function PairRows({
  label,
  values,
  onChange,
  description,
  valueLabel,
  errorId,
  invalid,
}: {
  label: string
  values: McpPairs
  onChange: (values: McpPairs) => void
  description?: string
  valueLabel?: string
  errorId?: string
  invalid?: boolean
}): React.JSX.Element {
  const id = useId()
  function update(index: number, column: 0 | 1, value: string): void {
    onChange(
      values.map((pair, i) =>
        i === index ? (column === 0 ? [value, pair[1]] : [pair[0], value]) : pair
      )
    )
  }
  return (
    <FieldSet>
      <FieldLegend variant="label">{label}</FieldLegend>
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldGroup className="gap-2">
        {values.map(([key, value], index) => (
          <FieldGroup
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"
          >
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor={`${id}-${index}-key`} className={index ? "sr-only" : undefined}>
                键{index ? ` ${index + 1}` : ""}
              </FieldLabel>
              <Input
                id={`${id}-${index}-key`}
                aria-label={`${label} ${index + 1} 键`}
                value={key}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                onChange={(e) => update(index, 0, e.target.value)}
              />
            </Field>
            <Field data-invalid={invalid}>
              <FieldLabel
                htmlFor={`${id}-${index}-value`}
                className={index ? "sr-only" : undefined}
              >
                {valueLabel ?? "值"}
                {index ? ` ${index + 1}` : ""}
              </FieldLabel>
              <Input
                id={`${id}-${index}-value`}
                aria-label={`${label} ${index + 1} ${valueLabel ?? "值"}`}
                value={value}
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                onChange={(e) => update(index, 1, e.target.value)}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="mb-0.5"
              aria-label={`移除${label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </FieldGroup>
        ))}
      </FieldGroup>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => onChange([...values, ["", ""]])}
      >
        <Plus data-icon="inline-start" />
        添加{label}
      </Button>
    </FieldSet>
  )
}

export function McpFormFields({
  value,
  onChange,
  error,
  errorId,
}: {
  value: McpForm
  onChange: (value: McpForm) => void
  error: string
  errorId: string
}): React.JSX.Element {
  const id = useId()
  const invalid = (key: string): boolean => Boolean(error && error.includes(key))
  function update<K extends keyof McpForm>(key: K, next: McpForm[K]): void {
    onChange({ ...value, [key]: next })
  }
  function text(
    key: "name" | "command" | "cwd" | "url" | "bearer_token_env_var",
    label: string,
    placeholder: string,
    description?: string
  ): React.JSX.Element {
    const bad = invalid(key === "name" ? "名称" : key)
    return (
      <Field data-invalid={bad}>
        <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
        <Input
          id={`${id}-${key}`}
          value={value[key]}
          placeholder={placeholder}
          aria-invalid={bad}
          aria-describedby={bad ? errorId : description ? `${id}-${key}-hint` : undefined}
          onChange={(e) => update(key, e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {description && <FieldDescription id={`${id}-${key}-hint`}>{description}</FieldDescription>}
      </Field>
    )
  }
  return (
    <FieldGroup>
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        {text("name", "名称（必填）", "例如：my-server")}
        <Field>
          <FieldLabel id={`${id}-type`}>连接类型</FieldLabel>
          <ToggleGroup
            aria-labelledby={`${id}-type`}
            value={[value.type]}
            onValueChange={(v) => {
              if (v[0]) update("type", v[0] as McpForm["type"])
            }}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="stdio">STDIO</ToggleGroupItem>
            <ToggleGroupItem value="http">HTTP</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>
      {value.type === "stdio" ? (
        <>
          {text(
            "command",
            "启动命令（必填）",
            "例如：npx 或可执行文件路径",
            "只填写可执行程序；每个命令行参数单独添加在下方。"
          )}
          <StringRows
            label="参数"
            values={value.args}
            onChange={(v) => update("args", v)}
            invalid={invalid("args")}
            errorId={errorId}
          />
          <PairRows
            label="环境变量"
            values={value.env}
            onChange={(v) => update("env", v)}
            invalid={invalid("env")}
            errorId={errorId}
          />
          <StringRows
            label="透传环境变量"
            values={value.env_vars}
            onChange={(v) => update("env_vars", v)}
            description="填写变量名，例如 PATH。接入后端后，将从运行环境读取对应的值。"
            invalid={invalid("env_vars")}
            errorId={errorId}
          />
          {text(
            "cwd",
            "工作目录",
            "例如：D:/projects/my-server",
            "可选。启动服务器进程时使用的目录。"
          )}
        </>
      ) : (
        <>
          {text("url", "服务器 URL（必填）", "https://example.com/mcp")}
          {text(
            "bearer_token_env_var",
            "Bearer Token 环境变量",
            "例如：MCP_API_TOKEN",
            "可选。填写存放令牌的环境变量名。"
          )}
          <PairRows
            label="HTTP 请求头"
            values={value.http_headers}
            onChange={(v) => update("http_headers", v)}
            invalid={invalid("http_headers")}
            errorId={errorId}
          />
          <PairRows
            label="请求头环境变量"
            values={value.env_http_headers}
            valueLabel="环境变量名"
            description="键填写请求头名称，值填写对应的环境变量名。"
            onChange={(v) => update("env_http_headers", v)}
            invalid={invalid("env_http_headers")}
            errorId={errorId}
          />
        </>
      )}
      <FieldDescription>
        其他 JSON 字段会保留。切换连接类型也会保留原类型的字段，可在 JSON 中查看或移除。
      </FieldDescription>
    </FieldGroup>
  )
}
