import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  status: string;
  model: string;
}

export function StatusBar({ status, model }: StatusBarProps) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text color="cyan">OpenHarness</Text>
      <Text color="gray">{model}</Text>
      <Text color={status === "ready" ? "green" : "yellow"}>{status}</Text>
    </Box>
  );
}
