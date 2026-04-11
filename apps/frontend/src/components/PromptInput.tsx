import React from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function PromptInput({ value, onChange, onSubmit }: PromptInputProps) {
  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      onChange("");
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    onChange(value + input);
  });

  return (
    <Box paddingX={1}>
      <Text color="green">&gt; </Text>
      <Text>{value}</Text>
      <Text color="gray">|</Text>
    </Box>
  );
}
