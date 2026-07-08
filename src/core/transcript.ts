// The transcript shapes the segmenter consumes and produces (extracted from
// the convariance transcription contract — PRD 001 §6/§7). Consumers depend
// ONLY on these shapes, never on an STT provider SDK or wire format: a
// provider adapter reduces its stream to "ordered tokens with a speaker label
// and an is-final bit" (ProviderToken/ProviderResult), and the segmenter
// groups those into TranscriptSegments.

/** Internal speaker id — stable across late relabels (the provider's 'S1' may
 *  move, this never does). */
export type SpeakerId = string

export interface TranscriptSegment {
  id: string
  /** MUTABLE — may change on a late relabel or a user merge. */
  speakerId: SpeakerId
  text: string
  startMs: number
  endMs: number
  isFinal: boolean
  confidence?: number
}

// --- Provider-shaped events (pre-segmentation) ------------------------------

/** One result-word or provider token. `providerSpeaker` is the raw label; the
 *  segmenter maps it to a SpeakerId. */
export interface ProviderToken {
  text: string
  providerSpeaker: string
  isFinal: boolean
  startMs?: number
  endMs?: number
  confidence?: number
}

/** One message's worth of tokens. `isFinal` is the batch-level flag (true =
 *  settled transcript; false = volatile partial tail). */
export interface ProviderResult {
  tokens: ProviderToken[]
  isFinal: boolean
}
