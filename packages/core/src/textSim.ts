// Tiny lexical-similarity helpers shared by the reflex's card echo guard and the
// session's delegation de-dup. A normalized token set + Jaccard overlap — cheap,
// deterministic, no model call. Two pieces of text are "the same point" when
// their overlap clears ECHO_THRESHOLD; we use it to drop a reworded card the
// reflex just surfaced AND to collapse a redundant/superseded delegation before
// it reaches the local Claude.

export const ECHO_THRESHOLD = 0.5

export function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  )
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}
