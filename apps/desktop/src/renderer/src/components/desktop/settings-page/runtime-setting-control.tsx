import { MonitorCog } from "lucide-react"
import { useEffect, useState } from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import type { DesktopAgentEnvironment } from "@shared/settings-types"
import { runtimeEnvironmentLabel, runtimeEnvironmentNotice } from "./runtime-setting-model"

export function RuntimeSettingControl(): React.JSX.Element {
  const [environment, setEnvironment] = useState<DesktopAgentEnvironment>("local")
  const [restartRequired, setRestartRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) {
          setEnvironment(snapshot.agentEnvironment)
          setRestartRequired(snapshot.restartRequired)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (next: "local" | "docker"): void => {
    if (saving || next === environment) return
    const previous = environment
    setEnvironment(next)
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateAgentEnvironment({ environment: next })
      .then((snapshot) => {
        setEnvironment(snapshot.agentEnvironment)
        setRestartRequired(snapshot.restartRequired)
      })
      .catch((caught: unknown) => {
        setEnvironment(previous)
        setError(errorMessage(caught))
      })
      .finally(() => setSaving(false))
  }

  const notice = runtimeEnvironmentNotice(environment, restartRequired)
  return (
    <div className="flex flex-col items-end gap-1.5" aria-busy={loading || saving}>
      <Select
        value={environment}
        onValueChange={(value) => {
          if (value === "local" || value === "docker") update(value)
        }}
      >
        <SelectTrigger
          aria-label="智能体运行环境"
          aria-invalid={Boolean(error)}
          disabled={loading || saving}
          className="min-w-44"
        >
          <MonitorCog />
          <SelectValue>{runtimeEnvironmentLabel(environment)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="local">本机</SelectItem>
            <SelectItem value="docker">Docker 沙箱</SelectItem>
            {environment === "unsupported_srt" ? (
              <SelectItem value="unsupported_srt" disabled>
                旧 SRT 配置（不支持）
              </SelectItem>
            ) : null}
          </SelectGroup>
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-ui-caption max-w-72 text-right text-destructive">
          {error}
        </p>
      ) : notice ? (
        <p className="text-ui-caption max-w-72 text-right text-muted-foreground">{notice}</p>
      ) : null}
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
