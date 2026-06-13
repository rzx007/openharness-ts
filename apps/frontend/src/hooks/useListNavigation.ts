import { useState, useCallback } from "react";

/**
 * 管理可滚动列表的高亮下标。
 * count 变化时 moveDown 会自动 clamp，但 index 不自动重置——
 * 调用者在列表内容变化时自行调用 setIndex(0)。
 */
export function useListNavigation(count: number) {
  const [index, setIndex] = useState(0);

  const moveUp = useCallback(() => {
    setIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const moveDown = useCallback(() => {
    setIndex((prev) => Math.max(0, Math.min(count - 1, prev + 1)));
  }, [count]);

  return { index, setIndex, moveUp, moveDown };
}
