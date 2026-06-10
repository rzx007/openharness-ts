import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

const WAIT_FRAMES = [
  "Agent is waiting for your input   ",
  "Agent is waiting for your input.  ",
  "Agent is waiting for your input.. ",
  "Agent is waiting for your input...",
];

function WaitingAnimation(): React.JSX.Element {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % WAIT_FRAMES.length), 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color="magenta" dimColor>
      {WAIT_FRAMES[frame]}
    </Text>
  );
}

function QuestionModal({
  modal,
  modalInput,
  setModalInput,
  onSubmit,
}: {
  modal: Record<string, unknown>;
  modalInput: string;
  setModalInput: (value: string) => void;
  onSubmit: (value: string) => void;
}): React.JSX.Element {
  const [extraLines, setExtraLines] = useState<string[]>([]);

  useInput((_chunk, key) => {
    if (key.shift && key.return) {
      setExtraLines((lines) => [...lines, modalInput]);
      setModalInput("");
    }
  });

  const handleSubmit = (value: string): void => {
    const allLines = [...extraLines, value];
    setExtraLines([]);
    onSubmit(allLines.join("\n"));
  };

  const toolName = modal.tool_name ? String(modal.tool_name) : null;
  const reason = modal.reason ? String(modal.reason) : null;
  const question = String(modal.question ?? "Question");

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="double" borderColor="magenta" paddingX={1}>
      <WaitingAnimation />
      <Box marginTop={1}>
        <Text color="magenta" bold>{"\u2753 "}</Text>
        <Text bold>{question}</Text>
      </Box>
      {toolName ? (
        <Text dimColor>
          {"  "}Tool: <Text color="cyan">{toolName}</Text>
        </Text>
      ) : null}
      {reason ? (
        <Text dimColor>{"  "}Reason: {reason}</Text>
      ) : null}
      {extraLines.length > 0 && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {extraLines.map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="cyan">{"> "}</Text>
        <TextInput value={modalInput} onChange={setModalInput} onSubmit={handleSubmit} />
      </Box>
      <Text dimColor>{"  "}shift+enter: newline | enter: submit</Text>
    </Box>
  );
}

/** \u6700\u591A\u6E32\u67D3\u591A\u5C11\u884C diff\uFF0C\u907F\u514D\u8D85\u957F\u6539\u52A8\u6491\u7206 TUI\u3002 */
const MAX_DIFF_LINES = 40;

/** \u6E32\u67D3\u4E00\u6BB5 unified diff\uFF1A+ \u7EFF / - \u7EA2 / @@ \u9752 / \u5176\u4F59\u6309\u9ED8\u8BA4\u8272\u3002 */
function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const allLines = diff.replace(/\n$/, "").split("\n");
  const lines = allLines.slice(0, MAX_DIFF_LINES);
  const truncated = allLines.length - lines.length;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line, i) => {
        // \u8DF3\u8FC7 jsdiff \u7684\u6587\u4EF6\u5934 --- / +++\uFF08\u5DF2\u77E5\u5197\u4F59\uFF09\uFF0C\u5176\u4F59\u6309\u9996\u5B57\u7B26\u7740\u8272\u3002
        if (line.startsWith("+++") || line.startsWith("---")) {
          return <Text key={i} dimColor>{line}</Text>;
        }
        if (line.startsWith("@@")) return <Text key={i} color="cyan">{line}</Text>;
        if (line.startsWith("+")) return <Text key={i} color="green">{line}</Text>;
        if (line.startsWith("-")) return <Text key={i} color="red">{line}</Text>;
        return <Text key={i} dimColor>{line}</Text>;
      })}
      {truncated > 0 ? (
        <Text dimColor>{`  \u2026 ${truncated} more line(s)`}</Text>
      ) : null}
    </Box>
  );
}

export function ModalHost({
  modal,
  modalInput,
  setModalInput,
  onSubmit,
}: {
  modal: Record<string, unknown> | null;
  modalInput: string;
  setModalInput: (value: string) => void;
  onSubmit: (value: string) => void;
}): React.JSX.Element | null {
  if (modal?.kind === "permission") {
    const diff = modal.diff ? String(modal.diff) : null;
    const diffPath = modal.diff_path ? String(modal.diff_path) : null;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="yellow" bold>{"\u250C "}</Text>
          <Text bold>Allow </Text>
          <Text color="cyan" bold>{String(modal.tool_name ?? "tool")}</Text>
          <Text bold>?</Text>
        </Text>
        {modal.reason ? (
          <Text>
            <Text color="yellow">{"\u2502 "}</Text>
            <Text dimColor>{String(modal.reason)}</Text>
          </Text>
        ) : null}
        {diff ? (
          <Box flexDirection="column" marginTop={1}>
            {diffPath ? <Text dimColor>{"  "}{diffPath}</Text> : null}
            <DiffView diff={diff} />
          </Box>
        ) : null}
        <Text>
          <Text color="yellow">{"\u2514 "}</Text>
          <Text color="green">[y] Allow</Text>
          <Text>{"  "}</Text>
          <Text color="green">[a] Allow for session</Text>
          <Text>{"  "}</Text>
          <Text color="red">[n] Deny</Text>
        </Text>
      </Box>
    );
  }
  if (modal?.kind === "question") {
    return (
      <QuestionModal
        modal={modal}
        modalInput={modalInput}
        setModalInput={setModalInput}
        onSubmit={onSubmit}
      />
    );
  }
  if (modal?.kind === "mcp_auth") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="yellow" bold>{"\u{1F511} "}</Text>
          <Text bold>MCP Authentication</Text>
        </Text>
        <Text dimColor>{String(modal.prompt ?? "Provide auth details")}</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput value={modalInput} onChange={setModalInput} onSubmit={onSubmit} />
        </Box>
      </Box>
    );
  }
  return null;
}
