// Id minting. Segment and speaker ids only need to be unique within a session,
// so a prefixed monotonic counter is enough and keeps them human-scannable in
// the persisted record. Session ids fold in a timestamp so they sort by recency.

/** A collision-free, monotonic id generator scoped to one session. `start` lets
 *  a resumed session continue past the highest restored id so the fresh
 *  segmenter doesn't re-mint `seg_1` over an existing segment. */
export function createIdFactory(prefix: string, start = 0): () => string {
  let n = start
  return () => `${prefix}${++n}`
}

/** Highest numeric suffix among `ids` sharing `prefix` (0 if none). Used to
 *  resume id minting on a restored session without colliding with its ids. */
export function maxIdSuffix(ids: Iterable<string>, prefix: string): number {
  let max = 0
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/** A fresh session id: time-sortable, unique enough for a single-user browser. */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}`
}
