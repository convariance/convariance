// The browser side of the Claude Code bridge (PRD 007, the web half of F3/F4/F6).
// Since PRD 018 this is an app-agnostic EVENT EMITTER — the open-source-bound
// client. It knows the wire protocol and the forwarding/draining machinery, and
// NOTHING about the app: segments are PUSHED in (pushSegments), and everything
// it learns flows OUT as typed events the host adapts to its own state
// (convariance's adapter is storeBridge.ts — store writes, audio cues, debug
// panel).
//
//   transcript out → POST /bridge/transcript (sentence-level stable finals)
//   signals in     ← SSE /bridge/signals (preferred) or GET poll (fallback),
//                    resumed by `idx` so a dropped link loses nothing (F6).
//
// The room runs the AI FULLY AUTO: there is no confirm step and no raised hand.
// Every signal becomes an inline `turn` event at its contextual anchor; a
// `pending` signal opens a loading card that a later signal with the same `id`
// fills in. The lifecycle is driven by capture state (the host controller) so a
// restored/idle session never floods the gateway with a stale transcript, and
// leaving ends the round:
//   - activate()        capture went live — connect, forward, drain (idempotent;
//                       a resume from pause re-enables forwarding).
//   - setForwarding(on) pause/resume: stop/continue feeding the agent WITHOUT
//                       ending the round (the agent just parks idle).
//   - dispose()         stop / leave / unmount — end the round (POST /bridge/end,
//                       the agent stops listening) and tear everything down.

import type { BridgeMode, Signal, SignalType, TranscriptInput } from '@convariance/core'

/** One transcript segment as the client sees it: the host resolves the display
 *  speaker before pushing (contact names etc. are its concern). A segment's
 *  text must be APPEND-ONLY once final — that is what makes sentence-level
 *  forwarding safe. */
export interface BridgeSegment {
  id: string
  speaker: string
  text: string
}

/** Signal kinds that render as an inline contribution. The rest (raise_hand /
 *  address — retired by auto-run; graph — PRD 005) pass through only as raw
 *  `signal` events. */
const RENDERED_TYPES: ReadonlySet<SignalType> = new Set([
  'candidate',
  'insight',
  'caution',
  'note',
  'present'
])

/** Semantic connection states; the host maps them to its own UI copy. */
export type BridgeStatusEvent =
  | { state: 'connecting' }
  | { state: 'paired' }
  | { state: 'offline' }
  | { state: 'token-rejected' }
  /** Classifier mode only: the gateway reports `reflex_ready: false`, so the
   *  room's front door can never react (a missing server-side key). */
  | { state: 'classifier-unavailable' }
  /** The round ended underneath us (another session took over, or the agent
   *  left); forwarding has been stopped. */
  | { state: 'ended' }

/** The inline-contribution lifecycle, derived from the signal stream:
 *  - open    a `pending` signal opened a loading card
 *  - update  the same still-pending card changed (queued→working, new label)
 *  - fill    the signal completing a card opened earlier (same id)
 *  - add     a terminal card, rendered directly */
export type BridgeTurnEvent =
  | {
    action: 'open'
    id: string
    type: SignalType
    label: string
    detail?: string
    queued?: boolean
    speak?: boolean
    anchorSegmentId: string | null
    t: number
  }
  | { action: 'update'; id: string; queued: boolean; label?: string }
  | { action: 'fill'; id: string; text: string; speak?: boolean }
  | {
    action: 'add'
    id: string
    type: SignalType
    text: string
    detail?: string
    speak?: boolean
    anchorSegmentId: string | null
    t: number
  }

/** Liveness of the two AI layers, from /bridge/health. In drain mode there is
 *  no classifier — `reflex` then just mirrors gateway reachability (read `mode`
 *  to render it differently). */
export interface BridgePresenceEvent {
  mode: BridgeMode
  reflex: 'connecting' | 'connected' | 'unavailable'
  agent: 'off' | 'connected' | 'working'
}

/** Read receipts per segment id: `sent` = gateway acked the POST, `heard` = the
 *  room's front door (the classifier — or the agent itself in drain mode) has
 *  actually consumed it. */
export type BridgeDeliveryEvent = Record<string, 'sent' | 'heard'>

/** Client-side observability (the host's debug panel). */
export interface BridgeDebugEvent {
  kind: string
  message: string
  data?: Record<string, unknown>
}

export interface BridgeClientEventMap {
  status: BridgeStatusEvent
  turn: BridgeTurnEvent
  presence: BridgePresenceEvent
  delivery: BridgeDeliveryEvent
  /** Every newly-applied signal, raw — for kinds the turn lifecycle doesn't
   *  cover (e.g. `graph`) and for hosts that want the wire view. */
  signal: Signal
  debug: BridgeDebugEvent
}

/** The control surface the host's session lifecycle drives. */
export interface BridgeClientControls {
  /** Begin (or resume) forwarding + draining. Idempotent. */
  activate(): void
  /** Toggle transcript forwarding without ending the round (pause/resume). */
  setForwarding(on: boolean): void
  /** Live-tune the forward cadence. `tailIdleMs` is read live; a changed
   *  `flushMs` restarts the flush interval. */
  setParams(partial: { flushMs?: number; tailIdleMs?: number }): void
  dispose(): void
}

export interface BridgeClient extends BridgeClientControls {
  on<K extends keyof BridgeClientEventMap>(
    event: K,
    listener: (payload: BridgeClientEventMap[K]) => void
  ): () => void
  /** Hand the client the CURRENT full segment list whenever it changes. The
   *  client tracks per-segment forwarded cursors itself, so pushing the whole
   *  list is cheap and idempotent. */
  pushSegments(segments: BridgeSegment[]): void
}

export interface BridgeClientOptions {
  /** Gateway HTTP origin, e.g. http://127.0.0.1:7700. Empty = same origin —
   *  the gateway serves the web app from its own loopback port (PRD 007 §6.1),
   *  so the common case needs no URL at all. */
  endpoint?: string
  /** Pairing token (PRD 007 §6). */
  token: string
  /** The name the room uses to address the AI (PRD 004 F2). Default "Claude". */
  triggerName?: string
  /** The session id + title the live round belongs to (two-way connect): synced
   *  to the gateway on activate so the durable event log keys on the host's
   *  own id. A thunk is resolved at activate time (a pre-live title rename
   *  sticks). */
  session?: { id: string; title?: string } | (() => { id: string; title?: string })
  /** Segments already on screen at construction — RESTORED from a prior round.
   *  They are marked fully forwarded (only capture from now on enters the live
   *  stream) and handed once to the gateway's passive archive for on-demand
   *  recall. */
  restored?: BridgeSegment[]
  /** Forward cadence overrides (defaults: flushMs 600, tailIdleMs 3200). */
  params?: { flushMs?: number; tailIdleMs?: number }
}

const FLUSH_MS = 600
const RECONNECT_MS = 2500
const POLL_MS = 1500
// Cadence for the read-receipt / liveness poll: read the gateway's classify (or
// drain) cursor so transcript bubbles can show a "heard" tick, and notice if the
// round ended out from under us. Loopback, so cheap; only runs while active.
const HEALTH_MS = 700
// How long an open segment's trailing INCOMPLETE sentence must sit unchanged
// before we forward it anyway (the speaker paused mid-thought). MUST be >= the
// segmenter's pauseMs (3000) so a resumed utterance starts a NEW segment rather
// than extending this one — otherwise we'd double-send the continuation. Only a
// trailing partial waits this long; completed sentences go out on the next tick.
const TAIL_IDLE_MS = 3200

// A sentence boundary at the tail of a clause: terminal punctuation, allowing
// trailing quotes/brackets, followed by whitespace or end-of-text. Mirrors the
// segmenter's SENTENCE_END but used here to split a settled run into sentences.
const SENTENCE_BOUNDARY = /[.?!]['"”’)\]]*(?=\s|$)/g

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split text into complete sentences (terminated by punctuation) plus the
 *  trailing `rest` that has not yet closed. `consumed` is how many chars the
 *  complete sentences span (so the caller can advance its forwarded cursor). */
function splitSentences(text: string): {
  sentences: string[]
  rest: string
  consumed: number
} {
  const sentences: string[] = []
  let last = 0
  SENTENCE_BOUNDARY.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SENTENCE_BOUNDARY.exec(text)) !== null) {
    const end = m.index + m[0].length
    const s = text.slice(last, end).trim()
    if (s) sentences.push(s)
    last = end
  }
  return { sentences, rest: text.slice(last), consumed: last }
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  // Default to the gateway-served origin (same-origin) when no URL is set.
  const base = (opts.endpoint || window.location.origin).replace(/\/+$/, '')
  const token = opts.token
  const triggerName = (opts.triggerName || 'Claude').trim() || 'Claude'
  const authHeaders = { 'content-type': 'application/json', 'x-bridge-token': token }
  // A loose, word-boundary match on the room's name for the AI. Deliberately
  // permissive: a hit only makes us forward the line SOONER (it skips the idle
  // backstop) — the agent still decides address-vs-mention in context, so a false
  // positive costs nothing but a slightly earlier flush.
  const triggerPattern = new RegExp(`\\b${escapeRegExp(triggerName)}\\b`, 'i')
  function mentionsTrigger(text: string): boolean {
    return triggerPattern.test(text)
  }

  // --- events out ------------------------------------------------------------
  const listeners = new Map<keyof BridgeClientEventMap, Set<(p: never) => void>>()
  function addListener<K extends keyof BridgeClientEventMap>(
    event: K,
    listener: (payload: BridgeClientEventMap[K]) => void
  ): () => void {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(listener as (p: never) => void)
    return () => set.delete(listener as (p: never) => void)
  }
  function emit<K extends keyof BridgeClientEventMap>(
    event: K,
    payload: BridgeClientEventMap[K]
  ): void {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of set) (fn as (p: BridgeClientEventMap[K]) => void)(payload)
  }
  const emitDebug = (kind: string, message: string, data?: Record<string, unknown>) =>
    emit('debug', { kind, message, ...(data ? { data } : {}) })

  let disposed = false
  // Lifecycle: nothing flows until the controller calls activate() on the first
  // `live` (so a restored/idle session stays silent). `forwarding` gates the
  // transcript feed only (pause stops it without ending the round).
  let activated = false
  let forwarding = false
  // The gateway round ended out from under us (e.g. another browser session took
  // over, or we switched away and came back). We stop forwarding and say so
  // rather than silently feeding a transcript no agent is reading.
  let endedDetected = false
  // A status-level failure was reported; the next healthy poll emits `paired` to
  // clear it.
  let errored = false
  // Which front door the gateway runs (PRD 018) — learned from /bridge/health.
  // Decides the read-receipt cursor (classified vs delivered) and whether
  // `reflex_ready: false` matters.
  let mode: BridgeMode = 'classifier'

  // Forward cadence (defaults = FLUSH_MS / TAIL_IDLE_MS; the host may seed from
  // its persisted debug params). `flushMs` drives the flush interval (restarted
  // on change); `tailIdleMs` is read live in the idle backstop.
  let flushMs = opts.params?.flushMs || FLUSH_MS
  let tailIdleMs = opts.params?.tailIdleMs || TAIL_IDLE_MS

  // --- transcript out -------------------------------------------------------
  // Decoupled from the UI's coarse segments: the agent is fed at SENTENCE
  // granularity the moment each sentence completes, while the on-screen bubbles
  // stay long and readable. Safe because a final segment's text is append-only
  // (the segmenter only extends the open segment by appending), so once we've
  // forwarded the first N chars they never change.
  let segments: BridgeSegment[] = opts.restored ?? []
  // segment id → chars of that UI segment already forwarded to the gateway.
  const forwarded = new Map<string, number>()
  // Restored segments are marked fully forwarded so a resume feeds the agent
  // only transcript captured AFTER resume — re-sending the whole history floods
  // the gateway and reads in-room as the AI re-reacting to old lines.
  for (const seg of segments) forwarded.set(seg.id, seg.text.length)
  // …but the agent can still RECALL that history on demand: snapshot it now and
  // hand it to the gateway's passive archive on activate (POST /bridge/history),
  // where the recall read finds it without it ever hitting the live stream.
  const restoredHistory: TranscriptInput[] = segments
    .filter((seg) => seg.text)
    .map((seg) => ({ speaker: seg.speaker, text: seg.text, kind: 'speech' }))
  // Each pending line keeps its source segment id so we can map the gateway's
  // assigned `seg` number back to it once the POST is acked (for anchoring).
  const pending: { input: TranscriptInput; segmentId: string }[] = []
  // Gateway `seg` number → our segment id. Built from POST acks; lets a signal's
  // `ref.seg` provenance resolve to the transcript bubble it refers to. (Several
  // gateway segs now map to one UI segment — fine, anchoring scrolls to the run.)
  const segByGatewaySeg = new Map<number, string>()
  // Our segment id → the HIGHEST gateway `seg` number forwarded for it. A UI
  // bubble has been fully "heard" once the gateway's heard cursor reaches this
  // (and all the bubble's text is forwarded). Drives the read-receipt tick.
  const maxGatewaySegBySegment = new Map<string, number>()
  // Last heard cursor seen from /bridge/health: how far the room's front door
  // (the classifier — or the agent itself in drain mode) has consumed the
  // transcript. Drives the read receipt.
  let lastHeard = 0

  function enqueueLine(seg: BridgeSegment, text: string): void {
    if (!text) return
    pending.push({
      input: { speaker: seg.speaker || 'Speaker', text, kind: 'speech' },
      segmentId: seg.id
    })
  }

  // Forward newly-stable text from every segment. A settled segment (one a newer
  // segment follows) is fully stable; the open last segment yields its completed
  // sentences and holds its trailing partial — unless `flushTail`, the idle
  // backstop, releases that too.
  // Returns true if it forwarded a line that names the AI (a likely direct
  // address), so the caller can flush immediately instead of waiting for the
  // FLUSH_MS tick — the room then gets its loading-card ack as fast as possible.
  function harvest(flushTail: boolean): boolean {
    if (!forwarding) return false
    const lastIdx = segments.length - 1
    let addressed = false
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (!seg?.text) continue
      const already = forwarded.get(seg.id) ?? 0
      const remaining = seg.text.slice(already)
      if (!remaining) continue
      const settled = i !== lastIdx
      const { sentences, rest, consumed } = splitSentences(remaining)
      for (const s of sentences) {
        enqueueLine(seg, s)
        if (mentionsTrigger(s)) addressed = true
      }
      let used = consumed
      const tail = rest.trim()
      // Force out a trailing partial when the segment settled, the idle backstop
      // fired, OR the partial names the AI. An address often lands unpunctuated on
      // the open tail; holding it for TAIL_IDLE_MS read in-room as the AI being
      // slow to react ("stuck while someone speaks"). Releasing it on the name
      // gets the words to the agent ~3 s sooner; the agent still judges whether
      // it's a real address. Accepts the odd fragmented line as the cost.
      const named = tail !== '' && mentionsTrigger(tail)
      if (tail && (settled || flushTail || named)) {
        enqueueLine(seg, tail)
        used = remaining.length
        if (named) addressed = true
      }
      forwarded.set(seg.id, already + used)
    }
    return addressed
  }

  async function flush(): Promise<void> {
    if (disposed || pending.length === 0) return
    const batch = pending.slice()
    try {
      const res = await fetch(`${base}/bridge/transcript`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ lines: batch.map((b) => b.input) })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // The ack reports the running total + how many it accepted, so the seg
      // numbers it just assigned are [total-added+1 .. total] — map each back to
      // our segment id. (Control lines also consume seg numbers; deriving the
      // range from each ack stays correct regardless of interleaving.)
      const data = (await res.json().catch(() => null)) as
        | { added?: number; total?: number }
        | null
      if (data && typeof data.total === 'number' && typeof data.added === 'number') {
        const start = data.total - data.added + 1
        for (let i = 0; i < data.added && i < batch.length; i++) {
          const line = batch[i]
          if (!line) continue
          const gatewaySeg = start + i
          segByGatewaySeg.set(gatewaySeg, line.segmentId)
          const prev = maxGatewaySegBySegment.get(line.segmentId) ?? 0
          if (gatewaySeg > prev) maxGatewaySegBySegment.set(line.segmentId, gatewaySeg)
        }
      }
      pending.splice(0, batch.length) // drop only what we actually sent
      emitDebug(
        'forward',
        `flushed ${batch.length} line${batch.length === 1 ? '' : 's'} → gateway`
      )
      // A just-acked line is now `sent`; refresh receipts (the heard cursor
      // may already cover it, flipping it straight to `heard`).
      updateDelivery()
    } catch {
      // Leave `pending` intact; the flush timer retries (F6 — no loss).
    }
  }

  // Recompute the per-segment read receipts from the heard cursor + how far
  // each bubble has been forwarded, and emit the map. A bubble is `heard` once
  // the front door has consumed up to its last forwarded seg AND all its
  // current text has been forwarded (so a still-growing live bubble shows
  // `sent` until the speaker settles it); otherwise `sent`.
  function updateDelivery(): void {
    const next: BridgeDeliveryEvent = {}
    for (const seg of segments) {
      const maxSeg = maxGatewaySegBySegment.get(seg.id)
      if (maxSeg === undefined) continue
      const fullyForwarded = (forwarded.get(seg.id) ?? 0) >= seg.text.length
      next[seg.id] = lastHeard >= maxSeg && fullyForwarded ? 'heard' : 'sent'
    }
    emit('delivery', next)
  }

  // Resolve where a signal belongs in the feed: its last `ref.seg` mapped to our
  // segment id (walking back to the nearest mapped speech line if it points at a
  // control line / gap), else the live edge as a fallback.
  function anchorFor(sig: Signal): string | null {
    const refs = sig.ref
    const refSeg = refs?.length ? refs[refs.length - 1]?.seg : undefined
    if (typeof refSeg === 'number') {
      for (let s = refSeg; s >= 1; s--) {
        const id = segByGatewaySeg.get(s)
        if (id) return id
      }
    }
    return segments[segments.length - 1]?.id ?? null
  }

  // Two-way connect: bind the gateway round to THIS session's id (and title)
  // so the durable event log keys on the host's own id and a join by id
  // attaches to this exact round. Adopting a DIFFERENT id resets the
  // gateway round (fresh buffers/cursors), so this must land before primeCursor
  // reads the signal cursor. Best-effort: an older gateway 404s, harmless.
  async function adoptSession(): Promise<void> {
    const session =
      typeof opts.session === 'function' ? opts.session() : opts.session
    if (!session) return
    try {
      await fetch(`${base}/bridge/session`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ session_id: session.id, title: session.title })
      })
    } catch {
      // best-effort; the gateway keys the round on its own minted id
    }
  }

  // Hand the gateway the restored prior-round history once, into its passive
  // archive (read only by the recall tool). Best-effort; recall is non-critical.
  async function postHistory(): Promise<void> {
    if (restoredHistory.length === 0) return
    try {
      await fetch(`${base}/bridge/history`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ lines: restoredHistory })
      })
    } catch {
      // best-effort; the agent simply won't be able to recall prior rounds
    }
  }

  // The one-time session-config control line (v5): it carries the room's name
  // for the AI in a machine marker the gateway classifier parses
  // (`[trigger: name]`) so the front door can judge direct address. Posted once
  // at activate (applies to this round only).
  function postSessionConfig(): void {
    void postControl(
      `Session config — the room addresses the AI as "${triggerName}". ` +
        `[trigger: ${triggerName}]`
    )
  }

  async function postControl(text: string): Promise<void> {
    try {
      await fetch(`${base}/bridge/transcript`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ speaker: 'facilitator', text, kind: 'control' })
      })
    } catch {
      // best-effort; the user can repeat the action
    }
  }

  // Track the open last segment's un-forwarded tail so the idle backstop can
  // release a trailing partial sentence once the speaker stops (the next thing
  // we'd otherwise wait on — a new segment — never comes if they're done).
  let tailSig = ''
  let tailSince = 0
  function trackTail(): void {
    const last = segments[segments.length - 1]
    const already = last ? forwarded.get(last.id) ?? 0 : 0
    const rest = last ? last.text.slice(already) : ''
    const sig = last ? `${last.id}:${rest}` : ''
    if (sig !== tailSig) {
      tailSig = sig
      tailSince = Date.now()
    }
  }

  // Started in activate(); torn down in dispose().
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let healthTimer: ReturnType<typeof setInterval> | null = null

  // The flush loop: a periodic flush plus the idle backstop. Pulled out so a
  // live `flushMs` change can restart it at the new cadence.
  function startFlushTimer(): void {
    if (flushTimer) clearInterval(flushTimer)
    flushTimer = setInterval(() => {
      // Idle backstop: an un-forwarded trailing partial that hasn't changed for
      // tailIdleMs means the speaker stopped — forward it so their final words
      // aren't stranded on the tail.
      const last = segments[segments.length - 1]
      const hasTail = last ? (forwarded.get(last.id) ?? 0) < last.text.length : false
      if (hasTail && Date.now() - tailSince >= tailIdleMs) {
        emitDebug('tail', 'idle backstop → flush trailing partial')
        harvest(true)
      }
      void flush()
    }, flushMs)
  }

  // --- signals in -----------------------------------------------------------
  const seen = new Set<number>() // signal idxs already applied (dedup, F6 replay)
  const openSnippets = new Set<string>() // pending card ids awaiting completion
  const closedIds = new Set<string>() // ids already filled (out-of-order guard)
  let cursor = 0 // next signal idx to request (resume point)
  let es: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function idFor(idx: number): string {
    return `sig_${idx}`
  }

  function applySignal(sig: Signal): void {
    // Idempotent: the SSE backlog, the poll fallback, and a reconnect can all
    // re-deliver the same idx — apply each exactly once (fixes doubled cards).
    if (seen.has(sig.idx)) return
    seen.add(sig.idx)
    if (sig.idx + 1 > cursor) cursor = sig.idx + 1
    emitDebug(
      'signal',
      `applied ${sig.type}${sig.pending ? ' (pending)' : ''}: ${sig.text}`,
      { idx: sig.idx, id: sig.id }
    )
    emit('signal', sig)

    // Completion of a loading card opened earlier (same id, no longer pending).
    if (sig.id && !sig.pending && openSnippets.has(sig.id)) {
      openSnippets.delete(sig.id)
      closedIds.add(sig.id)
      emit('turn', { action: 'fill', id: sig.id, text: sig.text, speak: sig.speak })
      return
    }

    if (!RENDERED_TYPES.has(sig.type)) return // raise_hand / address / graph

    const turnId = sig.id ?? idFor(sig.idx)
    const anchorSegmentId = anchorFor(sig)

    if (sig.pending) {
      // Open a loading card; a later signal with this id fills in the result.
      // Insurance: if the fill already arrived out of order (id closed), the
      // result is on screen — don't reopen a card that will never be filled.
      if (closedIds.has(turnId)) return
      // A re-emit of an already-open card (same id, still pending) updates it in
      // place rather than opening a second card: the agent picked it up (queued →
      // working), or the classifier superseded a still-queued delegation (refined
      // label). Both keep the same loading card.
      if (openSnippets.has(turnId)) {
        emit('turn', {
          action: 'update',
          id: turnId,
          queued: sig.queued ?? false,
          label: sig.text || undefined
        })
        return
      }
      openSnippets.add(turnId)
      emit('turn', {
        action: 'open',
        id: turnId,
        type: sig.type,
        label: sig.text,
        detail: sig.detail,
        queued: sig.queued,
        speak: sig.speak,
        anchorSegmentId,
        t: sig.t
      })
      return
    }

    emit('turn', {
      action: 'add',
      id: turnId,
      type: sig.type,
      text: sig.text,
      detail: sig.detail,
      speak: sig.speak,
      anchorSegmentId,
      t: sig.t
    })
    // A terminal card with an id closes that id (covers an out-of-order fill
    // that beat its pending-open — the open is then skipped above).
    if (sig.id) closedIds.add(sig.id)
  }

  function signalsUrl(): string {
    // EventSource can't set headers, so the token rides the query string (the
    // gateway accepts it there for the SSE path). `since` resumes from cursor.
    return `${base}/bridge/signals?since=${cursor}&token=${encodeURIComponent(token)}`
  }

  // Health carries the token too: the hosted Worker routes /bridge/* (health
  // included) to this user's session by the pairing token, so it can't be open
  // the way the single-session local gateway's health was. The local gateway
  // ignores the extra query param, so this is safe for both.
  function healthUrl(): string {
    return `${base}/bridge/health?token=${encodeURIComponent(token)}`
  }

  function connectSse(): void {
    if (disposed) return
    let source: EventSource
    try {
      source = new EventSource(signalsUrl())
    } catch {
      scheduleReconnect()
      return
    }
    es = source
    source.onopen = () => {
      stopPolling()
      if (!endedDetected) {
        errored = false
        emit('status', { state: 'paired' })
      }
    }
    source.onmessage = (e: MessageEvent) => {
      try {
        applySignal(JSON.parse(String(e.data)) as Signal)
      } catch {
        // ignore keep-alive / non-JSON frames
      }
    }
    source.onerror = () => {
      // EventSource auto-retries from the same (stale) cursor, which would
      // replay; close it and reconnect ourselves from the live cursor instead.
      source.close()
      if (es === source) es = null
      if (disposed) return
      startPolling() // cover the gap while we re-open the stream
      scheduleReconnect()
    }
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectSse()
    }, RECONNECT_MS)
  }

  async function pollOnce(): Promise<void> {
    if (disposed) return
    try {
      const res = await fetch(signalsUrl())
      if (res.status === 401) {
        errored = true
        emit('status', { state: 'token-rejected' })
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // The poll path is the streaming action's buffered fallback: a JSON array.
      const signals = (await res.json()) as Signal[]
      for (const sig of signals) applySignal(sig)
      if (!endedDetected && errored) {
        errored = false
        emit('status', { state: 'paired' })
      }
    } catch {
      errored = true
      emit('status', { state: 'offline' })
    }
  }

  function startPolling(): void {
    if (pollTimer || disposed) return
    void pollOnce()
    pollTimer = setInterval(() => void pollOnce(), POLL_MS)
  }
  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  interface HealthShape {
    mode?: BridgeMode
    delivered?: number
    classified?: number
    signals_sent?: number
    session_ended?: boolean
    reflex_ready?: boolean
    agent_connected?: boolean
    agent_working?: boolean
  }

  function noteMode(s: HealthShape): void {
    if (s.mode === 'drain' || s.mode === 'classifier') mode = s.mode
  }

  // The heard cursor: how far the room's front door has consumed the
  // transcript. The classifier's cursor in classifier mode; the agent's own
  // drain cursor in drain mode (nothing advances `classified` there).
  function heardCursor(s: HealthShape): number | undefined {
    return mode === 'drain' ? s.delivered : s.classified
  }

  // Start this session at the gateway's LIVE EDGE, not idx 0. The gateway keeps
  // one ephemeral session whose signal buffer spans every browser session that
  // paired with it; without this, a fresh session would replay the previous
  // one's cards. `/bridge/health` reports `signals_sent` (= the next idx), so we
  // resume from there and only render signals produced from now on.
  async function primeCursor(): Promise<void> {
    try {
      const res = await fetch(healthUrl())
      if (!res.ok) return
      const status = (await res.json()) as HealthShape
      noteMode(status)
      if (typeof status.signals_sent === 'number') cursor = status.signals_sent
      applyPresence(status)
      // Classifier mode: the classifier is mandatory. A gateway without a key
      // can't react at all — surface that clearly instead of a silent dead room.
      // Drain mode has no classifier, so reflex_ready carries no weight there.
      if (status.reflex_ready === false && mode !== 'drain') {
        errored = true
        emit('status', { state: 'classifier-unavailable' })
      }
    } catch {
      // Unreachable — leave cursor at 0; pollOnce surfaces the offline state.
    }
  }

  // Map a /bridge/health snapshot to the presence event (front door + agent).
  // Pass nothing on a failed read → we've lost the signal, so show the front
  // door as (re)connecting and no agent.
  function applyPresence(s?: HealthShape): void {
    if (!s) {
      emit('presence', { mode, reflex: 'connecting', agent: 'off' })
      return
    }
    emit('presence', {
      mode,
      reflex:
        s.reflex_ready === false && mode !== 'drain' ? 'unavailable' : 'connected',
      agent: !s.agent_connected ? 'off' : s.agent_working ? 'working' : 'connected'
    })
  }

  // Read the gateway's heard cursor for read receipts, refresh the presence
  // event, and notice if the round ended underneath us (a clean cut elsewhere).
  // Runs only while activated; bails once disposed so our own end POST can't
  // trip the "left" state.
  async function pollHealth(): Promise<void> {
    if (disposed) return
    try {
      const res = await fetch(healthUrl())
      if (!res.ok) return
      const s = (await res.json()) as HealthShape
      noteMode(s)
      applyPresence(s)
      const heard = heardCursor(s)
      if (typeof heard === 'number' && heard !== lastHeard) {
        lastHeard = heard
        updateDelivery()
      }
      if (s.session_ended && !endedDetected) {
        endedDetected = true
        forwarding = false
        emit('status', { state: 'ended' })
      }
    } catch {
      // Offline is surfaced by the signal poll / SSE path; reflect the lost
      // health signal on the presence event.
      applyPresence()
    }
  }

  // --- lifecycle (driven by the host controller on capture state) ------------

  function pushSegments(next: BridgeSegment[]): void {
    if (disposed) return
    segments = next
    // A line that names the AI jumps the FLUSH_MS queue — send it right away.
    if (harvest(false)) void flush()
    trackTail()
  }

  function activate(): void {
    forwarding = true
    if (activated || disposed) return
    activated = true

    startFlushTimer()
    healthTimer = setInterval(() => void pollHealth(), HEALTH_MS)

    // Probe reachability up front so a not-running gateway shows a clear state
    // rather than a silent nothing (PRD 007 F8), then open the live drain. The
    // session-config line waits on this so the cursor prime reads the
    // post-adopt state.
    emit('status', { state: 'connecting' })
    // Adopt-first: the id sync can reset the gateway round, so the cursor prime
    // (and everything after it) must read the post-adopt state.
    void adoptSession().then(primeCursor).then(() => {
      if (disposed) return
      void pollOnce()
      void pollHealth()
      connectSse()
      postSessionConfig()
      // Hand over any restored prior-round history for on-demand recall (it
      // does NOT enter the live stream — see restoredHistory / postHistory).
      void postHistory()
    })

    // Catch up any transcript already on screen when capture went live.
    harvest(false)
    trackTail()
  }

  function setForwarding(on: boolean): void {
    forwarding = on
    emitDebug('capture', on ? 'forwarding resumed' : 'forwarding paused')
  }

  function setParams(partial: { flushMs?: number; tailIdleMs?: number }): void {
    if (typeof partial.tailIdleMs === 'number') tailIdleMs = Math.max(0, partial.tailIdleMs)
    if (typeof partial.flushMs === 'number') {
      flushMs = Math.max(50, partial.flushMs)
      if (flushTimer) startFlushTimer() // restart at the new cadence
    }
    emitDebug('params', 'forward cadence updated', { flushMs, tailIdleMs })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (flushTimer) clearInterval(flushTimer)
    if (healthTimer) clearInterval(healthTimer)
    stopPolling()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    es?.close()
    // A dormant client (a restored/idle session that never went live) must NOT
    // end the round — that round belongs to whichever session IS live. Only a
    // client that actually activated owns the cut.
    if (!activated) return
    // Flush whatever's left (including any held tail) and tell the agent the
    // session is over (it sends a closing note, then stops).
    forwarding = true
    harvest(true)
    void flush().then(() => {
      void fetch(`${base}/bridge/end`, {
        method: 'POST',
        headers: authHeaders
      }).catch(() => {})
    })
  }

  return { on: addListener, pushSegments, activate, setForwarding, setParams, dispose }
}
