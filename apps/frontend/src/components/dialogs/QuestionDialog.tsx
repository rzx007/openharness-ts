import React, { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";

/** 工具向用户提问的弹层：单行输入，enter 提交。带可选 tool/reason 提示。 */
export function QuestionDialog({
  modal,
  onSubmit,
}: {
  modal: Record<string, unknown>;
  onSubmit: (answer: string) => void;
}) {
  const { theme } = useTheme();
  const [inputValue, setInputValue] = useState("");
  const question = String(modal.question ?? "Question");
  const toolName = modal.tool_name ? String(modal.tool_name) : null;
  const reason = modal.reason ? String(modal.reason) : null;

  useKeyboard((key) => {
    if (key.name === "escape") {
      onSubmit("");
      return;
    }
    if (key.name === "return") {
      onSubmit(inputValue);
    }
  });

  return (
    <box flexDirection="column">
      <text fg={theme.colors.accent} attributes={TextAttributes.BOLD}>
        {"? " + question}
      </text>
      {toolName ? (
        <text fg={theme.colors.muted}>{`  Tool: ${toolName}`}</text>
      ) : null}
      {reason ? (
        <text fg={theme.colors.muted}>{`  Reason: ${reason}`}</text>
      ) : null}
      <input
        focused
        placeholder="Answer..."
        onInput={(value: string) => setInputValue(value)}
      />
      <text fg={theme.colors.muted}>{"  enter: submit  esc: cancel"}</text>
    </box>
  );
}
