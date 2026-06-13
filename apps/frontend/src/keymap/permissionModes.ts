/** 权限模式选项（/permissions 选择器与 Tab 循环共用）。 */
export const PERMISSION_MODES = [
  {
    value: "default",
    label: "default",
    description: "Ask for approval on sensitive operations",
  },
  {
    value: "full_auto",
    label: "full_auto",
    description: "Allow all operations without asking",
  },
  {
    value: "plan",
    label: "plan",
    description: "Plan mode — propose changes before executing",
  },
] as const;

/** Tab 循环顺序（与 PERMISSION_MODES 的 value 对应）。 */
export const PERMISSION_MODE_ORDER: string[] = ["default", "full_auto", "plan"];
