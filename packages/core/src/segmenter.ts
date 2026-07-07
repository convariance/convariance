// The shared normalizer: provider token batches -> TranscriptSegments grouped by
// speaker run. Providers reduce to "ordered tokens with a speaker label and an
// is-final bit", so this logic lives once, not per provider.
//
// Identity discipline (the React perf contract): segment OBJECTS are replaced,
// never mutated in place, so a changed segment gets a new reference; the store
// (not the segmenter) decides when to publish a new `finals` array, gated on
// `finalsChanged`. Interim is rebuilt fresh each call (it is volatile).

import type {
  ProviderResult,
  ProviderToken,
  SpeakerId,
  TranscriptSegment
} from './transcript.ts'

export interface NewSpeaker {
  providerLabel: string
  speakerId: SpeakerId
}

export interface SegmenterOutput {
  /** The accumulated settled segments (mutable speakerId). */
  finals: TranscriptSegment[]
  /** The volatile interim tail — replaced wholesale each ingest. */
  interim: TranscriptSegment[]
  /** Provider labels seen for the first time this ingest. */
  newSpeakers: NewSpeaker[]
  /** True if `finals` changed this ingest (gates the store's new-array publish). */
  finalsChanged: boolean
}

export interface Segmenter {
  ingest(result: ProviderResult): SegmenterOutput
  /** Fold the `remove` speaker into `keep` after a UI merge: re-route the
   *  provider label(s) so future tokens land on `keep`, and rewrite the
   *  accumulated finals so the next store re-slice doesn't revert the merge. */
  mergeSpeaker(remove: SpeakerId, keep: SpeakerId): void
  /** Seed the accumulated finals from a restored session so the next final batch
   *  APPENDS onto the existing transcript instead of replacing it. Without this,
   *  a resumed session's fresh segmenter starts empty and the first `applyResult`
   *  re-slice wipes the restored history. Call once, before the first ingest. */
  seed(finals: TranscriptSegment[]): void
  /** Patch the F10 thresholds live (the Debug Panel). `breaksRun` reads `cfg.*`
   *  on every token, so a change takes effect on the next token with no rebuild. */
  setConfig(partial: Partial<SegmentationConfig>): void
  reset(): void
}

/** F10 sub-speaker segmentation thresholds (PRD 001 §5 F10). Diarization gives
 *  us speaker *changes*; these break a single-speaker run into utterance-sized
 *  segments so a monologue never forms one ever-growing line (AC2). Tunable;
 *  bias to slightly coarser segments over chatty fragments (R3). */
export interface SegmentationConfig {
  /** Gap between a token's start and the open segment's end that forces a
   *  break (a real silence — a new thought). ~3–5 s. */
  pauseMs: number
  /** Minimum length a segment must reach before a sentence boundary is allowed
   *  to close it. Without this, every '.' starts a new line, so a burst of
   *  short sentences ("Yes. Right. Go on.") fragments one-per-line; this keeps
   *  them accumulating into one readable utterance. */
  minChars: number
  /** Hard upper bound on a segment's character length (the backstop). */
  maxChars: number
  /** Hard upper bound on a segment's wall-clock duration. */
  maxDurationMs: number
}

const DEFAULT_SEGMENTATION: SegmentationConfig = {
  pauseMs: 3000,
  minChars: 140,
  maxChars: 320,
  maxDurationMs: 30_000
}

const EMPTY: TranscriptSegment[] = []

// Sentence-ending punctuation at the tail of a segment (allowing trailing
// closing quotes/brackets). A completed sentence closes the current segment so
// the next word opens a fresh one.
const SENTENCE_END = /[.?!]['"”’)\]]*\s*$/

// Punctuation that attaches to the preceding word with no space (Speechmatics
// emits these as standalone tokens, e.g. a bare '.', so the default word-join
// would otherwise produce "there ." instead of "there.").
const ATTACHING_PUNCT = /^\s*[.,?!;:)\]}%'"”’]/

// Join provider token text: some providers' tokens carry their own leading
// spaces, Speechmatics words don't — so insert one only when neither side has
// it, and never before attaching punctuation.
function joinText(prev: string, next: string): string {
  if (!prev) return next.replace(/^\s+/, '')
  if (ATTACHING_PUNCT.test(next)) return prev + next.replace(/^\s+/, '')
  if (next.startsWith(' ') || prev.endsWith(' ')) return prev + next
  return `${prev} ${next}`
}

export function createSegmenter(opts: {
  mintSegmentId: () => string
  mintSpeakerId: () => SpeakerId
  segmentation?: Partial<SegmentationConfig>
}): Segmenter {
  const cfg: SegmentationConfig = { ...DEFAULT_SEGMENTATION, ...opts.segmentation }
  const finals: TranscriptSegment[] = []
  const labelToId = new Map<string, SpeakerId>()

  // F10: within a same-speaker run, decide whether the incoming token must
  // START a new segment rather than extend the open one. Break on a pause, a
  // completed sentence, or the length/duration backstop.
  function breaksRun(seg: TranscriptSegment, t: ProviderToken): boolean {
    // A clear silence gap always starts a new thought, regardless of length.
    if (
      t.startMs !== undefined &&
      seg.endMs !== undefined &&
      t.startMs - seg.endMs >= cfg.pauseMs
    ) {
      return true
    }
    // Hard backstops: never let a single segment grow unbounded.
    if (seg.text.length >= cfg.maxChars) return true
    if (seg.endMs - seg.startMs >= cfg.maxDurationMs) return true
    // A sentence boundary only closes the segment once it has enough body, so
    // back-to-back short sentences coalesce instead of breaking one-per-line.
    if (seg.text.length >= cfg.minChars && SENTENCE_END.test(seg.text)) {
      return true
    }
    return false
  }

  // Extend the open segment when the speaker matches AND no F10 boundary fires;
  // otherwise push a fresh segment with a freshly-minted id.
  function append(
    out: TranscriptSegment[],
    t: ProviderToken,
    speakerId: SpeakerId,
    isFinal: boolean,
    idFor: (runIndex: number) => string
  ): void {
    const last = out[out.length - 1]
    if (last?.speakerId === speakerId && !breaksRun(last, t)) {
      out[out.length - 1] = {
        ...last,
        text: joinText(last.text, t.text),
        endMs: t.endMs ?? last.endMs,
        confidence: t.confidence ?? last.confidence
      }
    } else {
      out.push({
        id: idFor(out.length),
        speakerId,
        text: t.text.replace(/^\s+/, ''),
        startMs: t.startMs ?? 0,
        endMs: t.endMs ?? t.startMs ?? 0,
        isFinal,
        confidence: t.confidence
      })
    }
  }

  function resolve(label: string, newSpeakers: NewSpeaker[]): SpeakerId {
    let id = labelToId.get(label)
    if (id === undefined) {
      id = opts.mintSpeakerId()
      labelToId.set(label, id)
      newSpeakers.push({ providerLabel: label, speakerId: id })
    }
    return id
  }

  // Group a token list into segments by speaker run, applying the F10
  // boundaries. `idFor(i)` supplies the segment id (minted for finals,
  // synthetic for the throwaway interim tail).
  function group(
    tokens: ProviderToken[],
    isFinal: boolean,
    idFor: (runIndex: number) => string,
    newSpeakers: NewSpeaker[]
  ): TranscriptSegment[] {
    const out: TranscriptSegment[] = []
    for (const t of tokens) {
      if (!t.text) continue
      const speakerId = resolve(t.providerSpeaker, newSpeakers)
      append(out, t, speakerId, isFinal, idFor)
    }
    return out
  }

  function ingest(result: ProviderResult): SegmenterOutput {
    const newSpeakers: NewSpeaker[] = []

    if (!result.isFinal) {
      // Interim batch: rebuild the tail from scratch. Synthetic ids keep the
      // monotonic segment counter clean (these segments are thrown away on the
      // next message or promoted when their final arrives).
      const interim = group(
        result.tokens,
        false,
        (i) => `int_${i}`,
        newSpeakers
      )
      return { finals, interim, newSpeakers, finalsChanged: false }
    }

    // Final batch: append to / extend the accumulated finals, continuing a run
    // across messages when the speaker matches the previous final segment and
    // no F10 boundary fires (a fresh id is minted only when a segment is
    // pushed).
    let finalsChanged = false
    for (const t of result.tokens) {
      if (!t.text) continue
      const speakerId = resolve(t.providerSpeaker, newSpeakers)
      append(finals, t, speakerId, true, opts.mintSegmentId)
      finalsChanged = true
    }
    // A final batch settles whatever interim preceded it.
    return { finals, interim: EMPTY, newSpeakers, finalsChanged }
  }

  function mergeSpeaker(remove: SpeakerId, keep: SpeakerId): void {
    if (remove === keep) return
    // Re-point every provider label that resolved to the removed speaker, so
    // future tokens land on `keep` instead of resurrecting `remove` (and so
    // `resolve` won't re-emit it as a "new" speaker).
    for (const [label, id] of labelToId) {
      if (id === remove) labelToId.set(label, keep)
    }
    // Rewrite the accumulated finals in place: the store re-slices this array on
    // every final batch (applyResult), so a store-only rewrite would be undone
    // on the next message.
    for (let i = 0; i < finals.length; i++) {
      const seg = finals[i]
      if (seg?.speakerId === remove) {
        finals[i] = { ...seg, speakerId: keep }
      }
    }
  }

  function seed(restored: TranscriptSegment[]): void {
    // Adopt the restored segments as our accumulated finals (own array, shared
    // segment refs — identity discipline holds since we replace slots, never
    // mutate in place). Future tokens mint fresh speaker ids (labelToId is empty
    // on a new provider session), so a continuation pushes a new segment rather
    // than extending a restored one.
    for (const s of restored) finals.push(s)
  }

  function setConfig(partial: Partial<SegmentationConfig>): void {
    // Mutate the captured cfg object in place — breaksRun closes over it, so the
    // next token sees the new thresholds (no segmenter rebuild, no state loss).
    Object.assign(cfg, partial)
  }

  function reset(): void {
    finals.length = 0
    labelToId.clear()
  }

  return { ingest, mergeSpeaker, seed, setConfig, reset }
}
