// The gateway's in-memory session state: the transcript queue, the signal
// queue, and the parked `wait_for_transcript` waiters. Pure and transport-free
// (no http, no stdio) so it is unit-testable and both faces share one source of
// truth. Everything resets on restart — a session is ephemeral; the durable
// copy lives in the browser's IndexedDB (PRD 002 / 007 §3).

import type {
  Signal,
  SignalInput,
  TranscriptInput,
  TranscriptLine,
  WaitResult,
  SessionStatus,
  GetTranscriptResult,
  HistoryLine,
  EventLine,
  SyncTranscriptResult,
  DebugEvent,
  DebugEventKind,
  Delegation,
  WaitDelegationResult,
  AgentMessage,
  Digest,
  VerdictSummary,
  ReflexParams
} from './protocol.ts'
import { PROTOCOL_VERSION } from './protocol.ts'
import { ECHO_THRESHOLD, jaccard, tokenize } from './textSim.ts'

/** Mint a fresh round id (PRD 011). `crypto.randomUUID` is global in both Node
 *  20+ (the local gateway) and workerd (a hosted session store). */
function newSessionId(): string {
  return `s_${crypto.randomUUID()}`
}

interface Waiter {
  resolve: (r: WaitResult) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface DelegationWaiter {
  resolve: (r: WaitDelegationResult) => void
  timer: ReturnType<typeof setTimeout> | null
}

type DelegationStatus = 'queued' | 'active' | 'done' | 'cancelled'

interface QueuedDelegation extends Delegation {
  status: DelegationStatus
  /** Token set of task+label, for the similarity de-dup. */
  tokens: Set<string>
  /** The loading-card fields, so picking the delegation up can re-emit the SAME
   *  card flipped from "queued" to "working" (the visible queue). Absent for a
   *  raw enqueueDelegation (stub/tests) that opened no card. */
  card?: { type: Signal['type']; text: string; detail?: string; ref?: SignalInput['ref'] }
}

/** The reflex's high-level "open a loading card AND hand the work to the agent"
 *  call. The card fields mirror SignalInput; `task` is the agent-prompt. */
export interface DelegateInput {
  type: Signal['type']
  text: string
  detail?: string
  ref?: SignalInput['ref']
  task: string
}

/** What delegate() decided — surfaced for debug/logging. */
export type DelegateAction = 'new' | 'superseded' | 'skipped'

export interface SessionOptions {
  /** Ceiling for a blocking wait, just under Claude Code's MCP tool timeout
   *  (PRD 007 F2 — the spike measured ~50 s usable under a 55 s cap). */
  maxBlockSec: number
}

export class BridgeSession {
  // The current round's id (PRD 011) — minted here, re-minted on reset(), carried
  // in the paired URL + status, and the key the durable event log + sessions
  // index use. A hosted deployment keys its durable rows by it.
  private sessionId: string = newSessionId()
  // The unified, append-only transcript-of-record: speech lines AND AI cards
  // interleaved in causal (append) order under one monotonic 1-based `idx` (the
  // sync cursor). This in-memory copy serves sync_transcript on the local gateway;
  // a hosted deployment can additionally mirror it to durable storage. Control
  // lines are NOT logged (machinery, not conversation); pending loading cards are
  // not logged either — only a card's real content lands here.
  private events: EventLine[] = []
  private transcript: TranscriptLine[] = []
  // Restored prior-round history (web → POST /bridge/history on resume). PASSIVE:
  // read only by getTranscript(), never drained into wait_for_transcript — so a
  // resume gives the agent recall without re-reacting to old lines (PRD 002/007).
  private archive: HistoryLine[] = []
  private signals: Signal[] = []
  private deliveredCursor = 0
  // How far the reflex has classified (heard) the transcript. In v5 this is the
  // read-receipt cursor (the reflex, not the agent, hears the room).
  private classifiedCursor = 0
  // The agent's work queue (v5): the reflex enqueues delegations here and the
  // agent drains them via wait_for_delegation. Decoupled from `transcript` so the
  // seg-numbering / browser anchoring is untouched and the agent never sees
  // speech (the sole-classifier contract — PRD 008 / sole-classifier migration).
  //
  // De-dup + sequence (the flood fix): each entry carries a status and its token
  // set. `delegate()` owns the open-card + queue lifecycle so a redundant or
  // superseded ask never reaches the local Claude:
  //   - skip   — a near-duplicate of the active or a recently-done delegation.
  //   - supersede — a near-duplicate of a STILL-QUEUED one: replace its brief in
  //     place (same id → the same loading card refines), don't pile a second on.
  //   - new    — open a pending card + queue it.
  // The agent drains ONE at a time (nextDelegation): while it works on `activeId`
  // the rest sit `queued`, which is exactly the window in which a newer take can
  // supersede them.
  private delegations: QueuedDelegation[] = []
  private activeId: string | null = null
  // The typed side channel (v7 — PRD 019): messages from the room's UI, queued
  // for the agent and delivered on the next wait return — waking a parked
  // waiter immediately (a deliberate ask never waits for the classifier or the
  // next heartbeat). Drained whole per wake.
  private messages: AgentMessage[] = []
  private messageSeq = 0
  // Chat persistence hook: a host (e.g. a durable session store) subscribes to
  // persist each `chat` event the moment it lands — the counterpart of the
  // onTranscript/onSignal hooks it already writes from.
  private readonly chatListeners = new Set<(event: EventLine) => void>()
  // Ambient awareness (v7): how far into the event log the agent's digest has
  // reached, plus the classifier verdicts recorded since its last wake. The
  // digest rides every wait return and is consumed exactly once per wake.
  private digestCursor = 0
  private verdicts: VerdictSummary[] = []
  private static readonly VERDICTS_MAX = 40
  private static readonly DIGEST_EVENTS_MAX = 60
  // Reflex-params change tracking (v7): the session doesn't own the params (the
  // classifier does) but it carries change NOTICE — a copy of the effective
  // params marked dirty on every change, shipped in the next digest, plus a
  // monotonic revision the browser client watches on the health poll.
  private lastParams: ReflexParams | null = null
  private paramsDirty = false
  private paramsRev = 0
  // Sliding window of recently-completed delegation token sets — the persistent
  // "already processed, don't touch again" guard. Bounded (not permanent) so a
  // topic the room genuinely revisits much later can be delegated again.
  private recentDoneTokens: Set<string>[] = []
  private delegateSeq = 0
  private static readonly RECENT_DONE_MAX = 8
  private ended = false
  private readonly waiters: Waiter[] = []
  private readonly delegationWaiters: DelegationWaiter[] = []
  private readonly signalListeners = new Set<(s: Signal) => void>()
  private readonly endListeners = new Set<() => void>()
  // Fired with each newly-appended batch of lines (the reflex layer's hook,
  // PRD 008 §3.1). Kept separate from waiters: a listener observes, it does not
  // drain — the Opus stream's cursor is untouched.
  private readonly transcriptListeners = new Set<(lines: TranscriptLine[]) => void>()
  private readonly resetListeners = new Set<() => void>()
  // The debug channel (observability only): a bounded ring buffer of recent
  // events (so a late-connecting browser gets backlog) + live listeners. Drained
  // over GET /bridge/debug. Cleared on reset() like the other per-round state.
  private debugBuffer: DebugEvent[] = []
  private debugSeq = 0
  private readonly debugListeners = new Set<(e: DebugEvent) => void>()
  private static readonly DEBUG_BUFFER_MAX = 500
  // True once the gateway wires the reflex (a server-side key is present). In v5
  // the reflex is mandatory, so this gates the round (GetSessionUrl hard-fails
  // when false) and is surfaced in status() as `reflex_ready`.
  private reflexReady = false
  // Agent presence (the live-Claude-Code signal). Stamped each time the agent
  // hits its WaitForDelegation heartbeat; status() reports it `connected` while
  // a waiter is parked, a delegation is in flight, or the last heartbeat is
  // within AGENT_TTL_MS. The TTL must exceed the block ceiling (≤50 s) so a slow
  // delegation between two heartbeats doesn't read as a drop.
  private agentSeenAt = 0
  private static readonly AGENT_TTL_MS = 70_000
  private readonly maxBlockSec: number

  constructor(opts: SessionOptions) {
    this.maxBlockSec = opts.maxBlockSec
  }

  /** Start a fresh session round on the same process: clear the transcript /
   *  signal buffers and lift the `ended` flag. The gateway keeps ONE ephemeral
   *  session for its whole life, but a clean cut (the room left → end) is now
   *  recoverable — a later launch (GetSessionUrl) resets here so the agent
   *  re-arms instead of seeing a permanently-ended session. Any waiter parked
   *  from a prior round (there should be none — the agent loop exits on
   *  session_ended) is released idle so it can't leak.
   *  `adoptSessionId` keys the new round on an existing session id instead of
   *  minting one (two-way connect: the browser round / a join-by-id owns the
   *  id). */
  reset(adoptSessionId?: string): void {
    // A new round gets a fresh id + a fresh event log; prior sessions live on in
    // a host's durable store (keyed by their own id), not here.
    this.sessionId = adoptSessionId ?? newSessionId()
    this.events = []
    this.transcript = []
    this.archive = []
    this.signals = []
    this.deliveredCursor = 0
    this.classifiedCursor = 0
    this.delegations = []
    this.activeId = null
    this.recentDoneTokens = []
    this.delegateSeq = 0
    this.messages = []
    this.messageSeq = 0
    this.digestCursor = 0
    this.verdicts = []
    // Reflex params SURVIVE a reset (they live on the classifier instance), but
    // re-mark them dirty so the new round's first digest tells the agent the
    // effective config it is running under.
    this.paramsDirty = this.lastParams !== null
    this.agentSeenAt = 0
    this.ended = false
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve({ lines: [], cursor: 0, session_ended: false, idle: true })
    }
    while (this.delegationWaiters.length) {
      const waiter = this.delegationWaiters.shift()!
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve({ delegations: [], session_ended: false, idle: true })
    }
    this.debugBuffer = []
    this.debugSeq = 0
    for (const listener of this.resetListeners) listener()
    this.emitDebug('lifecycle', 'session reset (new round armed)')
  }

  /** Adopt a session id for the current round (two-way connect). Same id →
   *  no-op apart from lifting a stale `ended` flag, so an agent joining the
   *  round the browser is live on (a join by id), or the browser
   *  re-activating, never disturbs the in-flight transcript / signal cursors.
   *  A DIFFERENT id means a different room is (now) live — start a clean round
   *  under that id (fresh reflex window, buffers, cursors). Returns whether a
   *  reset happened. */
  adopt(sessionId: string): { reset: boolean } {
    if (sessionId === this.sessionId) {
      if (this.ended) {
        this.ended = false
        this.emitDebug('lifecycle', 'session re-armed (adopted live id)')
      }
      return { reset: false }
    }
    this.reset(sessionId)
    return { reset: true }
  }

  // --- transcript in --------------------------------------------------------

  /** Append lines (stamping `seg`/`t`) and wake any parked waiter. Returns the
   *  stamped lines. */
  pushTranscript(inputs: TranscriptInput[]): TranscriptLine[] {
    const added: TranscriptLine[] = []
    for (const input of inputs) {
      if (!input?.text) continue
      const line: TranscriptLine = {
        seg: this.transcript.length + 1,
        speaker: input.speaker || 'Speaker',
        text: input.text,
        kind: input.kind === 'control' ? 'control' : 'speech',
        t: Date.now()
      }
      this.transcript.push(line)
      added.push(line)
      // Mirror speech into the durable event log (control lines stay out — they
      // are machinery, not conversation).
      if (line.kind === 'speech') {
        this.events.push({
          idx: this.events.length + 1,
          t: line.t,
          kind: 'speech',
          speaker: line.speaker,
          text: line.text
        })
      }
    }
    if (added.length) {
      this.emitDebug(
        'transcript',
        `+${added.length} line${added.length === 1 ? '' : 's'} (${this.transcript.length} total)`,
        { added: added.map((l) => ({ seg: l.seg, speaker: l.speaker, kind: l.kind })) }
      )
      this.flushWaiters()
      for (const listener of this.transcriptListeners) listener(added)
    }
    return added
  }

  /** Observe each newly-appended transcript batch WITHOUT draining the Opus
   *  stream (the reflex layer subscribes here, PRD 008). Returns an unsubscribe
   *  fn. The listener also sees control lines the gateway injects — it must
   *  ignore its own delegations to avoid a classify loop. */
  onTranscript(listener: (lines: TranscriptLine[]) => void): () => void {
    this.transcriptListeners.add(listener)
    return () => this.transcriptListeners.delete(listener)
  }

  /** Notified when a fresh session round resets the session (reset()), so the
   *  reflex layer can clear its rolling window + stand-down state. */
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener)
    return () => this.resetListeners.delete(listener)
  }

  /** Flag that the reflex is wired (a server-side key is present). In v5 this
   *  gates the round; surfaced in status() as `reflex_ready`. */
  setReflexReady(ready: boolean): void {
    this.reflexReady = ready
  }

  get isReflexReady(): boolean {
    return this.reflexReady
  }

  /** The reflex reports how far it has classified (heard) the transcript — the
   *  read-receipt cursor in v5. Monotonic; clamped to the transcript length. */
  markClassified(seg: number): void {
    const next = Math.min(Math.max(seg, this.classifiedCursor), this.transcript.length)
    this.classifiedCursor = next
  }

  // --- the typed side channel + ambient awareness (v7 — PRD 019) ------------

  /** A typed message from the room's UI, straight to the agent (bypassing the
   *  classifier — a typed ask is always deliberate). Appends a `chat` event to
   *  the durable log, queues the message for the next wait return, and wakes a
   *  parked waiter immediately. Returns the stamped message (null for empty
   *  text or an ended session). */
  postMessage(input: { text: string; from?: string }): AgentMessage | null {
    const text = input.text?.trim()
    if (!text || this.ended) return null
    const message: AgentMessage = {
      id: `msg_${++this.messageSeq}`,
      from: input.from?.trim() || 'You',
      text,
      t: Date.now()
    }
    const event: EventLine = {
      idx: this.events.length + 1,
      t: message.t,
      kind: 'chat',
      speaker: message.from,
      text: message.text
    }
    this.events.push(event)
    for (const listener of this.chatListeners) listener(event)
    this.messages.push(message)
    this.emitDebug('transcript', `chat from ${message.from}: ${message.text}`, {
      id: message.id
    })
    // Wake whichever waiter the agent is parked on (delegation loop in
    // classifier mode, transcript drain in drain mode).
    this.flushDelegationWaiters()
    this.flushWaiters()
    return message
  }

  /** Observe each `chat` event as it lands (the durable-persistence hook — the
   *  counterpart of onTranscript/onSignal for the typed side channel). Returns
   *  an unsubscribe fn. */
  onChat(listener: (event: EventLine) => void): () => void {
    this.chatListeners.add(listener)
    return () => this.chatListeners.delete(listener)
  }

  /** The classifier records each verdict here (acted or silent) so the agent's
   *  next digest carries what the front door heard and decided. Bounded — a
   *  long quiet park keeps only the most recent VERDICTS_MAX. */
  recordVerdict(v: Omit<VerdictSummary, 't'> & { t?: number }): void {
    const entry: VerdictSummary = { t: v.t ?? Date.now(), act: v.act }
    if (v.type !== undefined) entry.type = v.type
    if (v.text !== undefined) entry.text = v.text
    if (v.agent_note !== undefined) entry.agent_note = v.agent_note
    this.verdicts.push(entry)
    if (this.verdicts.length > BridgeSession.VERDICTS_MAX) {
      this.verdicts = this.verdicts.slice(-BridgeSession.VERDICTS_MAX)
    }
  }

  /** Note that the effective reflex params changed (either principal — the
   *  agent's configure-reflex tool or the UI's POST /bridge/config). Bumps the
   *  health-visible revision and marks the config for the next digest. */
  notifyParamsChanged(params: ReflexParams): void {
    this.lastParams = { ...params }
    this.paramsDirty = true
    this.paramsRev++
  }

  /** The current params revision (also on status()); lets a config read/write
   *  response carry the rev so a client can keep its change-watch primed. */
  get paramsRevision(): number {
    return this.paramsRev
  }

  /** Assemble (and consume) the digest since the agent's last wake: new
   *  durable-log events (capped at DIGEST_EVENTS_MAX, `truncated` when the gap
   *  was larger), the classifier verdicts, and the effective params when they
   *  changed. Undefined when nothing new — the wait return then omits it. */
  private buildDigest(): Digest | undefined {
    const total = this.events.length
    const hasEvents = total > this.digestCursor
    if (!hasEvents && this.verdicts.length === 0 && !this.paramsDirty) {
      return undefined
    }
    const gap = total - this.digestCursor
    const truncated = gap > BridgeSession.DIGEST_EVENTS_MAX
    const digest: Digest = {
      events: this.events.slice(
        truncated ? total - BridgeSession.DIGEST_EVENTS_MAX : this.digestCursor
      ),
      cursor: total,
      verdicts: this.verdicts
    }
    if (truncated) digest.truncated = true
    if (this.paramsDirty && this.lastParams) digest.config = { ...this.lastParams }
    this.digestCursor = total
    this.verdicts = []
    this.paramsDirty = false
    return digest
  }

  /** Drain the whole pending message queue (delivered once, on a wait return). */
  private takeMessages(): AgentMessage[] {
    if (this.messages.length === 0) return []
    return this.messages.splice(0, this.messages.length)
  }

  /** Replace the passive archive with a resumed session's restored history.
   *  Replaces (not appends) so a re-activate can't duplicate it. Does NOT wake
   *  waiters — the archive is read-on-demand only (getTranscript()), never part
   *  of the live drain. Returns the line count stored. */
  setArchive(inputs: TranscriptInput[]): number {
    this.archive = inputs
      .filter((i) => i?.text)
      .map((i) => ({
        speaker: i.speaker || 'Speaker',
        text: i.text,
        kind: i.kind === 'control' ? 'control' : 'speech'
      }))
    return this.archive.length
  }

  /** Read the full known transcript — restored history first, then this round so
   *  far — for on-demand recall. `search` filters to lines
   *  whose text contains it (case-insensitive); `limit` keeps the most recent N
   *  of the (optionally filtered) lines. `total` counts the whole transcript
   *  before filtering, so the agent can tell how much it didn't see. */
  getTranscript(opts: { limit?: number; search?: string } = {}): GetTranscriptResult {
    const all: HistoryLine[] = [
      ...this.archive,
      ...this.transcript.map((l) => ({
        speaker: l.speaker,
        text: l.text,
        kind: l.kind
      }))
    ]
    const total = all.length
    const q = opts.search?.trim().toLowerCase()
    const matched = q ? all.filter((l) => l.text.toLowerCase().includes(q)) : all
    const limit = opts.limit && opts.limit > 0 ? opts.limit : undefined
    const lines = limit ? matched.slice(-limit) : matched
    return { lines, total, returned: lines.length }
  }

  /** The current round's id (PRD 011). */
  getSessionId(): string {
    return this.sessionId
  }

  /** Incremental read of the durable event log (sync_transcript, v6): the events
   *  with `idx > since`, plus the new high-water `cursor` and the session `total`.
   *  `since: 0` replays the whole round (the purged-context case). Serves the
   *  LOCAL gateway from memory; a hosted deployment can override this with a
   *  durable read that survives eviction and spans prior sessions by id. */
  eventsSince(since = 0): SyncTranscriptResult {
    const from = Math.max(0, Math.floor(since))
    return {
      events: this.events.slice(from),
      cursor: this.events.length,
      total: this.events.length
    }
  }

  /** Mark the session ended and unblock every waiter with `session_ended`. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.emitDebug('lifecycle', 'session ended')
    this.flushWaiters()
    this.flushDelegationWaiters()
    for (const listener of this.endListeners) listener()
    this.endListeners.clear()
  }

  get isEnded(): boolean {
    return this.ended
  }

  // --- the blocking wait (the heartbeat, PRD 007 §4.3) ----------------------

  waitForTranscript(maxWaitSec?: number): Promise<WaitResult> {
    // In drain mode (no classifier — PRD 018) this IS the agent's heartbeat,
    // so it stamps liveness exactly like waitForDelegation does. Harmless in
    // classifier mode, where nothing calls this.
    this.agentSeenAt = Date.now()
    return new Promise((resolve) => {
      if (
        this.deliveredCursor < this.transcript.length ||
        this.messages.length > 0 ||
        this.ended
      ) {
        resolve(this.drainBatch())
        return
      }
      const secs = Math.max(1, Math.min(maxWaitSec || 25, this.maxBlockSec))
      const waiter: Waiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        // Idle timeout: cheap return so the agent just re-parks (no reasoning).
        resolve({
          lines: [],
          cursor: this.deliveredCursor,
          session_ended: this.ended,
          idle: true
        })
      }, secs * 1000)
      this.waiters.push(waiter)
    })
  }

  private drainBatch(): WaitResult {
    const lines = this.transcript.slice(this.deliveredCursor)
    this.deliveredCursor = this.transcript.length
    const result: WaitResult = {
      lines,
      cursor: this.deliveredCursor,
      session_ended: this.ended,
      idle: lines.length === 0
    }
    // Typed side-channel messages ride the same return (v7); their arrival
    // counts as work, so the wake isn't mistaken for an idle heartbeat.
    const messages = this.takeMessages()
    if (messages.length) {
      result.messages = messages
      result.idle = false
    }
    return result
  }

  private flushWaiters(): void {
    while (
      this.waiters.length &&
      (this.deliveredCursor < this.transcript.length ||
        this.messages.length > 0 ||
        this.ended)
    ) {
      const waiter = this.waiters.shift()!
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(this.drainBatch())
    }
  }

  // --- the delegation queue (the agent heartbeat, v5) -----------------------

  /** The reflex hands a unit of work to the agent. Owns the whole lifecycle —
   *  open the `pending` loading card AND queue the work — so de-dup is atomic: a
   *  redundant or superseded ask never reaches the local Claude, and we never
   *  open a stray spinning card for one we then drop. Returns what it decided:
   *    - skipped   — a near-duplicate of the active or a recently-done delegation.
   *    - superseded — a near-duplicate of a still-queued one: its brief is
   *      replaced in place (same id → the same loading card refines its label).
   *    - new       — a fresh card opened + work queued; a parked agent is woken.
   *  Ordering note: when `new`, the pending card is added BEFORE the work is
   *  visible to a drain, so the room always sees the loading card before any
   *  fill. */
  delegate(input: DelegateInput): { action: DelegateAction; id?: string } {
    const task = input.task.trim()
    const label = input.text.trim()
    const tokens = tokenize(`${task} ${label}`)

    // Skip a near-duplicate of the in-flight work or anything recently completed —
    // re-opening that card would just spin while the agent does (or already did)
    // the same thing.
    const active = this.activeId
      ? this.delegations.find((d) => d.id === this.activeId)
      : undefined
    if (active && jaccard(tokens, active.tokens) >= ECHO_THRESHOLD) {
      this.emitDebug('delegate', `skipped (active dup): ${label}`, { task })
      return { action: 'skipped' }
    }
    if (this.recentDoneTokens.some((s) => jaccard(tokens, s) >= ECHO_THRESHOLD)) {
      this.emitDebug('delegate', `skipped (recently done): ${label}`, { task })
      return { action: 'skipped' }
    }

    // Supersede a still-queued (not yet picked-up) delegation on the same topic:
    // refine its brief in place and re-emit the loading card under the SAME id so
    // the room's spinner just updates its label — no second card, no pile-up.
    const queued = this.delegations.find(
      (d) => d.status === 'queued' && jaccard(tokens, d.tokens) >= ECHO_THRESHOLD
    )
    if (queued) {
      queued.task = task
      queued.label = label
      queued.tokens = tokens
      queued.card = { type: input.type, text: label, detail: input.detail, ref: input.ref }
      this.emitDebug('delegate', `superseded ${queued.id}: ${label}`, { id: queued.id, task })
      // Still waiting (the agent hasn't picked this slot up) → keep the card queued.
      this.addSignal({ ...queued.card, id: queued.id, pending: true, queued: true })
      return { action: 'superseded', id: queued.id }
    }

    // New work: open the loading card (QUEUED — it flips to "working" only when the
    // agent picks it up, see nextDelegation), then queue it and wake a parked agent.
    const id = `reflex_${++this.delegateSeq}`
    const card = { type: input.type, text: label, detail: input.detail, ref: input.ref }
    this.addSignal({ ...card, id, pending: true, queued: true })
    this.delegations.push({ id, task, label, status: 'queued', tokens, card })
    this.emitDebug('delegate', `queued ${id}: ${label}`, { id, task })
    this.flushDelegationWaiters()
    return { action: 'new', id }
  }

  /** Low-level enqueue: push a pre-formed delegation WITHOUT opening a card or
   *  de-duping. Real classification goes through delegate() (card + de-dup); this
   *  exists for the stub reflex / tests that drive the wait_for_delegation
   *  round-trip directly. */
  enqueueDelegation(d: Delegation): void {
    this.delegations.push({ ...d, status: 'queued', tokens: tokenize(`${d.task} ${d.label}`) })
    this.emitDebug('delegate', `queued ${d.id}: ${d.label}`, { id: d.id, task: d.task })
    this.flushDelegationWaiters()
  }

  /** Block until a delegation is available (or maxWaitSec elapses), then return
   *  it — ONE at a time. The agent drains sequentially: each call first retires
   *  the previously-handed delegation (the agent coming back == it finished), then
   *  hands the next queued one. While the agent works, newer arrivals sit `queued`
   *  and can be superseded. Retains the idle-timeout heartbeat so the agent still
   *  wakes on a quiet cadence (timed reminders / session-end). */
  waitForDelegation(maxWaitSec?: number): Promise<WaitDelegationResult> {
    // The agent's heartbeat: every loop iteration lands here, so this is the
    // liveness signal the browser reads (status().agent_connected).
    this.agentSeenAt = Date.now()
    return new Promise((resolve) => {
      this.retireActive()
      if (this.hasQueued() || this.messages.length > 0 || this.ended) {
        resolve(this.delegationResult())
        return
      }
      const secs = Math.max(1, Math.min(maxWaitSec || 25, this.maxBlockSec))
      const waiter: DelegationWaiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const i = this.delegationWaiters.indexOf(waiter)
        if (i >= 0) this.delegationWaiters.splice(i, 1)
        // Idle timeout — but still carry the digest (v7): the heartbeat wake is
        // exactly when the agent reviews ambient context.
        resolve(this.delegationResult())
      }, secs * 1000)
      this.delegationWaiters.push(waiter)
    })
  }

  private hasQueued(): boolean {
    return this.delegations.some((d) => d.status === 'queued')
  }

  /** Mark the in-flight delegation done and record its tokens so an immediate
   *  re-ask of the same thing is skipped. Idempotent (no active → no-op). */
  private retireActive(): void {
    if (!this.activeId) return
    const active = this.delegations.find((d) => d.id === this.activeId)
    if (active?.status === 'active') {
      active.status = 'done'
      this.recentDoneTokens.push(active.tokens)
      if (this.recentDoneTokens.length > BridgeSession.RECENT_DONE_MAX) {
        this.recentDoneTokens.shift()
      }
    }
    this.activeId = null
  }

  /** Hand the oldest queued delegation to the agent, marking it active. Assumes
   *  the previous active was already retired by the caller. */
  private nextDelegation(): WaitDelegationResult {
    const next = this.delegations.find((d) => d.status === 'queued')
    if (!next) {
      return { delegations: [], session_ended: this.ended, idle: true }
    }
    next.status = 'active'
    this.activeId = next.id
    // The agent is now actually on it → flip its card from "queued" to "working"
    // (same id, still pending; the browser updates the open card in place).
    if (next.card) {
      this.addSignal({ ...next.card, id: next.id, pending: true, queued: false })
    }
    return {
      delegations: [{ id: next.id, task: next.task, label: next.label }],
      session_ended: this.ended,
      idle: false
    }
  }

  /** Assemble one wait return: the next delegation (if any) plus the pending
   *  side-channel messages and the ambient digest (v7). A message counts as
   *  work (idle false); a digest alone does not — it is context, not a task. */
  private delegationResult(): WaitDelegationResult {
    const result = this.nextDelegation()
    const messages = this.takeMessages()
    if (messages.length) {
      result.messages = messages
      result.idle = false
    }
    const digest = this.buildDigest()
    if (digest) result.digest = digest
    return result
  }

  private flushDelegationWaiters(): void {
    // Hand the single queued item to a parked agent only when nothing is in
    // flight (a parked waiter implies the agent is idle ⇒ no active; the guard is
    // belt-and-suspenders). A pending side-channel message wakes the waiter
    // regardless (v7). On end, drain every waiter idle so none leak.
    while (this.delegationWaiters.length) {
      const wake =
        this.ended ||
        this.messages.length > 0 ||
        (this.activeId === null && this.hasQueued())
      if (!wake) break
      const waiter = this.delegationWaiters.shift()!
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(this.delegationResult())
    }
  }

  // --- signals out ----------------------------------------------------------

  /** Record a signal (stamping `idx`/`t`) and notify live drainers (WS push). */
  addSignal(input: SignalInput): Signal {
    const signal: Signal = {
      idx: this.signals.length,
      type: input.type,
      text: input.text,
      t: Date.now()
    }
    if (input.detail !== undefined) signal.detail = input.detail
    if (input.confidence !== undefined) signal.confidence = input.confidence
    if (input.ref !== undefined) signal.ref = input.ref
    if (input.payload !== undefined) signal.payload = input.payload
    if (input.id !== undefined) signal.id = input.id
    if (input.pending !== undefined) signal.pending = input.pending
    if (input.queued !== undefined) signal.queued = input.queued
    if (input.speak !== undefined) signal.speak = input.speak
    this.signals.push(signal)
    // Mirror a card's REAL content into the durable event log. Skip pending
    // loading placeholders — only the completed contribution is logged, so the
    // transcript-of-record reads as one card per real AI point, not a label then
    // its fill.
    if (!signal.pending) {
      const event: EventLine = {
        idx: this.events.length + 1,
        t: signal.t,
        kind: 'card',
        cardType: signal.type,
        text: signal.text
      }
      if (signal.detail !== undefined) event.detail = signal.detail
      if (signal.id !== undefined) event.id = signal.id
      this.events.push(event)
    }
    this.emitDebug(
      'signal',
      `${signal.type}${signal.pending ? ' (pending)' : ''}: ${signal.text}`,
      { idx: signal.idx, id: signal.id, pending: signal.pending }
    )
    for (const listener of this.signalListeners) listener(signal)
    return signal
  }

  /** Signals with idx >= since (the polling/resume drain, PRD 007 F4/F6). */
  signalsSince(since: number): Signal[] {
    return this.signals.slice(Math.max(0, since))
  }

  get signalCount(): number {
    return this.signals.length
  }

  /** Subscribe to new signals (live push). Returns an unsubscribe fn. */
  onSignal(listener: (s: Signal) => void): () => void {
    this.signalListeners.add(listener)
    return () => this.signalListeners.delete(listener)
  }

  /** Async stream of signals added AFTER this call, ending when the session
   *  ends. Backs the SSE drain (the `drain-signals` streaming action): the
   *  caller first yields the backlog via `signalsSince`, then awaits live ones
   *  here. Converts the callback subscription into a backpressure-friendly
   *  async iterator (silkweave awaits each yield's wire drain). */
  async *liveSignals(): AsyncGenerator<Signal> {
    const queue: Signal[] = []
    let wake: (() => void) | null = null
    const ping = () => {
      const w = wake
      wake = null
      w?.()
    }
    const offSignal = this.onSignal((s) => {
      queue.push(s)
      ping()
    })
    this.endListeners.add(ping)
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!
        if (this.ended) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      offSignal()
      this.endListeners.delete(ping)
    }
  }

  // --- debug channel (observability) ----------------------------------------

  /** Emit a debug event: stamp seq/t, ring-buffer it, notify live drainers. */
  emitDebug(kind: DebugEventKind, message: string, data?: Record<string, unknown>): void {
    const event: DebugEvent = { seq: this.debugSeq++, t: Date.now(), kind, message }
    if (data) event.data = data
    this.debugBuffer.push(event)
    if (this.debugBuffer.length > BridgeSession.DEBUG_BUFFER_MAX) {
      this.debugBuffer.shift()
    }
    for (const listener of this.debugListeners) listener(event)
  }

  /** Buffered events with seq >= since (the poll / SSE-backlog drain). */
  debugSince(since: number): DebugEvent[] {
    return this.debugBuffer.filter((e) => e.seq >= since)
  }

  /** Subscribe to new debug events (live push). Returns an unsubscribe fn. */
  onDebug(listener: (e: DebugEvent) => void): () => void {
    this.debugListeners.add(listener)
    return () => this.debugListeners.delete(listener)
  }

  /** Async stream of debug events added AFTER this call, ending on session end.
   *  Backs the SSE debug drain — mirrors liveSignals (the caller first yields the
   *  backlog via debugSince, then awaits live ones here). */
  async *liveDebug(): AsyncGenerator<DebugEvent> {
    const queue: DebugEvent[] = []
    let wake: (() => void) | null = null
    const ping = () => {
      const w = wake
      wake = null
      w?.()
    }
    const offDebug = this.onDebug((e) => {
      queue.push(e)
      ping()
    })
    this.endListeners.add(ping)
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!
        if (this.ended) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      offDebug()
      this.endListeners.delete(ping)
    }
  }

  // --- bookkeeping ----------------------------------------------------------

  status(): SessionStatus {
    const working = this.activeId !== null
    // A parked transcript waiter counts too: in drain mode (PRD 018) the agent
    // parks on waitForTranscript, not waitForDelegation.
    const connected =
      working ||
      this.delegationWaiters.length > 0 ||
      this.waiters.length > 0 ||
      (this.agentSeenAt > 0 && Date.now() - this.agentSeenAt < BridgeSession.AGENT_TTL_MS)
    return {
      protocol_version: PROTOCOL_VERSION,
      session_id: this.sessionId,
      transcript_lines: this.transcript.length,
      delivered: this.deliveredCursor,
      classified: this.classifiedCursor,
      signals_sent: this.signals.length,
      session_ended: this.ended,
      reflex_ready: this.reflexReady,
      agent_connected: connected,
      agent_working: working,
      params_rev: this.paramsRev
    }
  }
}
