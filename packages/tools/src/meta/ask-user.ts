import type { ToolDefinition } from "@openharness/core";

export const askUserTool: ToolDefinition = {
  name: "AskUser",
  description: "Ask the interactive user a follow-up question and return the answer.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
    },
    required: ["question"],
  },
  async execute(input, context) {
    const askFn = (context as any).askUserPrompt as
      | ((q: string) => Promise<string>)
      | undefined;
    if (!askFn) {
      return {
        content: [{ type: "text", text: "ask_user_question is unavailable in this session" }],
        isError: true,
      };
    }
    const answer = (await askFn(input.question as string)).trim();
    return { content: [{ type: "text", text: answer || "(no response)" }] };
  },
};
