import { fuzzyFilterScored } from "./fuzzy";
import { rank as frecencyRank } from "../services/frecency";
import type { Command } from "../keymap/commands";

/**
 * 斜杠命令排序：先按 fuzzy 匹配分，分数相同再按 frecency（最近+高频）排序。
 *
 * Prompt 的补全浮窗（展示项）与回车执行（原始 Command）共用这一份排序结果，
 * 避免把 fuzzyFilterScored + frecencyRank + sort 重复计算两遍。
 */
export function rankSlashCommands(commands: Command[], query: string): Command[] {
  const scores = frecencyRank("command");
  return fuzzyFilterScored(commands, query, (c) => c.id)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (scores.get(b.item.id) ?? 0) - (scores.get(a.item.id) ?? 0);
    })
    .map(({ item }) => item);
}
