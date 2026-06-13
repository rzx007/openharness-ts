import React, { useCallback, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import { DiffView } from "./DiffView";

/** 工具授权弹层：y=本次放行，a=整个会话放行，n=拒绝。带可选 reason 与 diff 预览。 */
export function PermissionDialog({
  modal,
  onRespond,
}: {
  modal: Record<string, unknown>;
  onRespond: (allowed: boolean, scope: "once" | "session") => void;
}) {
  const { theme } = useTheme();
  const respondedRef = useRef(false);

  const respond = useCallback(
    (allowed: boolean, scope: "once" | "session") => {
      if (respondedRef.current) return;
      respondedRef.current = true;
      onRespond(allowed, scope);
    },
    [onRespond],
  );

  useKeyboard((key) => {
    if (key.name === "y") {
      respond(true, "once");
    } else if (key.name === "a") {
      respond(true, "session");
    } else if (key.name === "n") {
      respond(false, "once");
    }
  });

  const toolName = modal.tool_name ? String(modal.tool_name) : "tool";
  const reason = modal.reason ? String(modal.reason) : null;
  const diff = modal.diff ? String(modal.diff) : null;
  const diffPath = modal.diff_path ? String(modal.diff_path) : null;

  return (
    <box flexDirection="column">
      <text>
        <span fg={theme.colors.warning} attributes={TextAttributes.BOLD}>{"┌ "}</span>
        <span attributes={TextAttributes.BOLD}>{"Allow "}</span>
        <span fg={theme.colors.info} attributes={TextAttributes.BOLD}>{toolName}</span>
        <span attributes={TextAttributes.BOLD}>{"?"}</span>
      </text>
      {reason ? (
        <text>
          <span fg={theme.colors.warning}>{"│ "}</span>
          <span fg={theme.colors.muted}>{reason}</span>
        </text>
      ) : null}
      {diff ? (
        <box flexDirection="column">
          {diffPath ? <text fg={theme.colors.muted}>{`  ${diffPath}`}</text> : null}
          <DiffView diff={diff} />
        </box>
      ) : null}
      <text>
        <span fg={theme.colors.warning}>{"└ "}</span>
        <span fg={theme.colors.success}>{"[y] Allow"}</span>
        <span>{"  "}</span>
        <span fg={theme.colors.success}>{"[a] Allow for session"}</span>
        <span>{"  "}</span>
        <span fg={theme.colors.error}>{"[n] Deny"}</span>
      </text>
    </box>
  );
}
