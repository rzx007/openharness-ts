import { readFile } from "node:fs/promises";

/**
 * 一次文件改动的预览：路径 + 改动前内容 + 改动后内容。**不写盘**。
 */
export interface FileChangePreview {
  path: string;
  before: string;
  after: string;
}

/**
 * 计算 Edit/Write 将产生的文件改动，用于"改文件前看 diff"的权限预览。
 *
 * **纯计算，不写盘**：只读当前文件内容，按与 `fileEditTool`/`fileWriteTool`
 * **完全一致**的替换逻辑算出 after，供权限层生成 diff 展示给用户。
 *
 * 返回 `null` 的情况（调用方应回退到无 diff 的普通确认）：
 * - 非 Edit/Write 工具（无 diff 概念）。
 * - 入参缺字段。
 * - Edit 的 old_string 在文件中找不到，或多处匹配但未 replace_all
 *   ——这些情况工具执行时本就会报错，没有可预览的 after。
 * - 读文件失败（Edit 针对不存在的文件）。
 */
export async function computeFileChange(
  toolName: string,
  input: Record<string, unknown>,
): Promise<FileChangePreview | null> {
  if (toolName === "Write") return computeWriteChange(input);
  if (toolName === "Edit") return computeEditChange(input);
  return null;
}

async function computeWriteChange(
  input: Record<string, unknown>,
): Promise<FileChangePreview | null> {
  const path = input.file_path;
  const content = input.content;
  if (typeof path !== "string" || typeof content !== "string") return null;

  // 文件可能不存在（首次写）——此时 before 视为空串。
  let before = "";
  try {
    before = await readFile(path, "utf-8");
  } catch {
    before = "";
  }
  return { path, before, after: content };
}

async function computeEditChange(
  input: Record<string, unknown>,
): Promise<FileChangePreview | null> {
  const path = input.file_path;
  const oldString = input.old_string;
  const newString = input.new_string;
  const replaceAll = (input.replace_all as boolean) ?? false;
  if (
    typeof path !== "string" ||
    typeof oldString !== "string" ||
    typeof newString !== "string"
  ) {
    return null;
  }

  let before: string;
  try {
    before = await readFile(path, "utf-8");
  } catch {
    return null; // 文件不存在：Edit 会报错，无可预览。
  }

  // 与 fileEditTool 一致的校验：找不到 / 多处匹配但未 replace_all → 无预览。
  if (!before.includes(oldString)) return null;
  const occurrences = before.split(oldString).length - 1;
  if (occurrences > 1 && !replaceAll) return null;

  const after = replaceAll
    ? before.replaceAll(oldString, newString)
    : before.replace(oldString, newString);

  return { path, before, after };
}
