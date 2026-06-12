import React from "react";
import { useTheme } from "../theme/ThemeContext";
import type { SwarmTeammateSnapshot, SwarmNotificationSnapshot } from "../types";

function statusIcon(status: SwarmTeammateSnapshot["status"]): string {
  switch (status) {
    case "running":
      return "🟢";
    case "idle":
      return "🟡";
    case "done":
      return "✅";
    case "error":
      return "🔴";
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s}s`;
}

export type SwarmPanelProps = {
  teammates: SwarmTeammateSnapshot[];
  notifications: SwarmNotificationSnapshot[];
};

export function SwarmPanel({
  teammates,
  notifications,
}: SwarmPanelProps) {
  const { theme } = useTheme();
  const c = theme.colors;

  if (teammates.length === 0 && notifications.length === 0) return null;

  const recentNotifications = notifications.slice(-3);

  return (
    <box flexDirection="column">
      {teammates.map((teammate) => {
        const icon = statusIcon(teammate.status);
        const durationStr =
          teammate.duration !== undefined
            ? ` (${formatDuration(teammate.duration)})`
            : "";
        const taskStr = teammate.task
          ? " " + teammate.task.slice(0, 40)
          : "";
        return (
          <text key={teammate.name} fg={c.foreground}>
            {icon + " " + teammate.name + durationStr + taskStr}
          </text>
        );
      })}
      {recentNotifications.map((n, i) => (
        <text key={i} fg={c.muted}>
          {`[${n.from}] ${n.message}`}
        </text>
      ))}
    </box>
  );
}
