import React, { useState } from "react";
import { Box, Text } from "ink";
import { PromptInput } from "./components/PromptInput";
import { StatusBar } from "./components/StatusBar";
import { useBackendSession } from "./hooks/useBackendSession";

export interface AppProps {
  config: {
    backendCommand?: string;
    theme?: string;
  };
}

export function App({ config }: AppProps) {
  const [input, setInput] = useState("");
  const { status, events, sendMessage } = useBackendSession(config.backendCommand);

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar status={status} model="claude-sonnet-4-20250514" />
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {events.map((event, i) => (
          <Text key={i}>{JSON.stringify(event)}</Text>
        ))}
      </Box>
      <PromptInput value={input} onChange={setInput} onSubmit={sendMessage} />
    </Box>
  );
}
