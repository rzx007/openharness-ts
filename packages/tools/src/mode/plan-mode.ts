import type { ToolDefinition } from "@openharness/core";

export const enterPlanModeTool: ToolDefinition = {
  name: "EnterPlanMode",
  description: "Switch permission mode to plan.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    const { loadSettings, saveSettings } = await import("@openharness/core");
    const settings = await loadSettings();
    settings.permissionMode = "plan";
    await saveSettings(settings);
    return { content: [{ type: "text", text: "Permission mode set to plan" }] };
  },
};

export const exitPlanModeTool: ToolDefinition = {
  name: "ExitPlanMode",
  description: "Switch permission mode back to default.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    const { loadSettings, saveSettings } = await import("@openharness/core");
    const settings = await loadSettings();
    settings.permissionMode = "default";
    await saveSettings(settings);
    return { content: [{ type: "text", text: "Permission mode set to default" }] };
  },
};
