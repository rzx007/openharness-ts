/**
 * Fuzzy filter: case-insensitive matching with scoring.
 *
 * Matching strategy:
 * - If query contains a word separator (`/`), apply prefix filtering:
 *   the label must start with the query (case-insensitive). This supports
 *   slash-command prefix filtering like `/p` → `/permissions`, `/plan`.
 * - Otherwise, use subsequence matching across the full label.
 *   Score: consecutive run bonus + label-prefix bonus.
 *
 * Sort order: descending by score, stable (same-score items preserve input order).
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (t: T) => string,
): T[] {
  if (query === "") return items;
  const q = query.toLowerCase();

  const hasSeparator = q.includes("/");

  const scored: Array<{ item: T; score: number; index: number }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const label = key(item).toLowerCase();

    let score: number;
    if (hasSeparator) {
      // Prefix filter: label must start with the query
      score = label.startsWith(q) ? 100 + (q.length === label.length ? 10 : 0) : 0;
    } else {
      score = scoreSubsequence(label, q);
    }

    if (score > 0) {
      scored.push({ item, score, index: i });
    }
  }

  // Stable descending sort by score
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}

function scoreSubsequence(label: string, query: string): number {
  let qi = 0;
  let score = 0;
  let consecutive = 0;

  for (let li = 0; li < label.length && qi < query.length; li++) {
    if (label[li] === query[qi]) {
      consecutive++;
      score += consecutive * 2;
      // Bonus for matching at label start
      if (li === 0 && qi === 0) score += 10;
      qi++;
    } else {
      consecutive = 0;
    }
  }

  if (qi < query.length) return 0; // Not a full subsequence match
  return score;
}
