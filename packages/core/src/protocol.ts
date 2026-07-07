// The bridge protocol — the single source of truth for the wire shapes that
// flow between the web app, the local gateway, and Claude Code (PRD 007 §4).
// This module is BROWSER-SAFE: types and plain constants only, no Node imports,
// so the gateway (Node) and the web client (browser) both depend on it and can
// never drift. Bump PROTOCOL_VERSION on any breaking shape change (G3).

// v2 added the `address` signal (PRD 004 direct address). v3 added `id` +
// `pending` to every signal (the auto-run pivot): the AI now renders inline with
// no confirm step, and a contribution that needs work first lands as a `pending`
// placeholder (a loading card) that a later signal with the same `id` completes.
// v4 added the on-demand transcript history: a resumed session hands the gateway
// its restored prior-round transcript (POST /bridge/history) into a PASSIVE
// archive the agent reads only via `get_transcript` — it is never fed into the
// live wait_for_transcript stream, so resuming doesn't make the AI re-react to
// old lines, but the AI can still recall earlier context when the room asks.
// All additive — older readers ignore the new endpoint/tool.
// PRD 008 (Instant Mode) adds an optional `instant_available` flag to the status
// shape and rides on the existing `kind: 'control'` (delegation) + `pending`/`id`
// (fill-in-place) primitives — all additive, so no PROTOCOL_VERSION bump.
// v5 makes the reflex the SOLE front-door classifier: the agent no longer drains
// speech (no `wait_for_transcript`) — it parks on `wait_for_delegation` and only
// completes work the reflex hands it. `instant_available` is renamed to the now
// load-bearing `reflex_ready` (a missing key hard-fails the round), and status
// gains `classified` (how far the reflex has heard — the new read-receipt
// cursor, since the reflex, not the agent, is what hears the room).
// v6 (PRD 011) makes the transcript a DURABLE, append-only event log of record —
// speech lines AND AI cards interleaved under one monotonic `idx`. `get_transcript`
// (the in-memory recall read) is replaced by `sync_transcript`: an incremental,
// re-requestable pull (`{ session_id?, since } → { events, cursor, total }`) the
// agent mirrors to a local JSONL it can grep. A real `session_id` (minted at
// GetSessionUrl, carried in the paired URL + status) keys the log so prior
// sessions can be listed / reloaded / deleted (the sessions index), and the
// SessionDO persists the log to DO-SQLite so it survives eviction and a context
// purge. The SPA becomes the read client (server is the system of record).
// PRD 018 (the open-source core split) adds the gateway MODE, additively: a
// gateway configured WITHOUT a classifier runs in `drain` mode — the agent
// hears the room itself via `wait_for_transcript` (the pre-v5 loop, which never
// left the session core), GetSessionUrl does not gate on `reflex_ready`, and
// `delivered` (not `classified`) is the read-receipt cursor. Health stamps
// `mode`; absent = `classifier` (older gateways / the hosted SessionDO).
export const PROTOCOL_VERSION = 6

/** Default loopback port for the gateway's HTTP/WS face. */
export const BRIDGE_DEFAULT_PORT = 7700

/** Which front door drives the gateway (PRD 018, additive): `classifier` = the
 *  v5 sole-classifier loop (the agent parks on `wait_for_delegation`); `drain` =
 *  no classifier configured — the agent drains speech itself via
 *  `wait_for_transcript`. Stamped onto the health payload by the gateway face;
 *  a missing field means `classifier`. */
export type BridgeMode = 'classifier' | 'drain'

// --- Transcript in (web → gateway → agent) ----------------------------------

/** A finalized, segmented transcript line (PRD 001 — sane units, not one
 *  growing line). `kind: 'control'` carries a facilitator instruction (floor
 *  grant, dismissal, direct-address confirmation) the agent reacts to in the
 *  same loop (§4.1). */
export interface TranscriptLine {
  seg: number
  speaker: string
  text: string
  t: number
  kind: 'speech' | 'control'
}

/** What a producer (web app / dev feeder) POSTs; the gateway stamps `seg`/`t`. */
export interface TranscriptInput {
  speaker: string
  text: string
  kind?: 'speech' | 'control'
}

// --- Signals out (agent → gateway → web) ------------------------------------

/** The escalation ladder (§4.2): most are ambient, few demand attention.
 *  `address` is the dual of `raise_hand` — the agent reports it was *directly
 *  addressed and asked to do something* (PRD 004): `text` is the extracted
 *  request, `ref` its transcript span, `confidence` the agent's certainty. The
 *  web app confirms (Respond / Dismiss) and grants the floor via the normal
 *  `present` path, so an address never collides with a self-raised hand. */
export type SignalType =
  | 'candidate'
  | 'insight'
  | 'caution'
  | 'raise_hand'
  | 'address'
  | 'present'
  | 'graph'
  | 'note'

export const SIGNAL_TYPES: readonly SignalType[] = [
  'candidate',
  'insight',
  'caution',
  'raise_hand',
  'address',
  'present',
  'graph',
  'note'
]

export interface Signal {
  idx: number
  type: SignalType
  text: string
  /** One-clause rationale (the why). */
  detail?: string
  /** 0..1 where meaningful. */
  confidence?: number
  /** Transcript provenance, where relevant. */
  ref?: { seg: number }[]
  /** Type-specific payload (e.g. a graph delta — PRD 005 schema). */
  payload?: unknown
  /** Correlation id linking a `pending` placeholder to the signal that
   *  completes it (v3). When two signals share an `id`, the second fills the
   *  card the first opened. */
  id?: string
  /** True when this signal is a placeholder shown as a loading card; a later
   *  signal with the same `id` carries the result (v3). */
  pending?: boolean
  /** For a `pending` delegation card: true while it WAITS in the queue (the agent
   *  is busy or not connected), flipped to false once the agent picks it up and is
   *  actually working it. Lets the room see a real queue — one card "working", the
   *  rest "queued" — instead of several spinners at once (additive). */
  queued?: boolean
  /** Whether this contribution should be READ ALOUD when it surfaces (additive,
   *  no version bump). The AI flags it: true = speak it (a short spoken reply),
   *  false = stay silent (a link / artifact handoff / long text). Undefined =
   *  let the room's kind-based auto-speak default decide. */
  speak?: boolean
  t: number
}

/** What the agent passes to `send_signal`; the gateway stamps `idx`/`t`. */
export interface SignalInput {
  type: SignalType
  text: string
  detail?: string
  confidence?: number
  ref?: { seg: number }[]
  payload?: unknown
  id?: string
  pending?: boolean
  queued?: boolean
  speak?: boolean
}

// --- MCP tool surface (gateway → Claude Code, §4.3) -------------------------

export const TOOL = {
  waitForDelegation: 'wait_for_delegation',
  /** Drain mode only (PRD 018): the agent's own transcript heartbeat. */
  waitForTranscript: 'wait_for_transcript',
  sendSignal: 'send_signal',
  sessionStatus: 'session_status',
  syncTranscript: 'sync_transcript'
} as const

// --- Delegations (gateway reflex → agent, v5) -------------------------------

/** A unit of work the reflex hands to the deliberate agent (Opus). The reflex
 *  has already opened a `pending` loading card with this `id`; the agent does
 *  the work and completes the card by sending a `present` signal with the SAME
 *  id. `task` is the agent-prompt; `label` is the loading-card text the room
 *  already sees. */
export interface Delegation {
  id: string
  task: string
  label: string
}

/** Return shape of `wait_for_delegation` — the agent's heartbeat. Mirrors
 *  WaitResult: it blocks until a delegation lands (or `max_wait_seconds`), so
 *  the agent still wakes on a quiet cadence to fire timed reminders / notice the
 *  session ending. `idle` true = nothing new; `session_ended` = wrap up + stop. */
export interface WaitDelegationResult {
  delegations: Delegation[]
  session_ended: boolean
  idle: boolean
}

// --- On-demand transcript history (get_transcript, v4) ----------------------

/** One line returned by `get_transcript`. Spans both the restored prior-round
 *  archive and this round's lines, oldest→newest; the agent reads these for
 *  recall, it does not use them to anchor signals (those ref the live `seg`). */
export interface HistoryLine {
  speaker: string
  text: string
  kind: 'speech' | 'control'
}

/** Return shape of `get_transcript`. `total` is the full known line count
 *  (archive + this round) before any `limit`/`search`; `returned` is how many
 *  this call yielded. */
export interface GetTranscriptResult {
  lines: HistoryLine[]
  total: number
  returned: number
}

// --- The durable event log (sync_transcript, v6 — PRD 011) ------------------

export type EventKind = 'speech' | 'card'

/** One entry in the unified append-only transcript-of-record: either a line of
 *  room speech (`kind: 'speech'`, `speaker` + `text`) or an AI contribution
 *  (`kind: 'card'`, `cardType` + `text` [+ `detail`/`id`]) — interleaved in the
 *  order they happened, under one monotonic `idx` (the sync cursor). Control
 *  lines (session-config) are NOT logged. */
export interface EventLine {
  idx: number
  t: number
  kind: EventKind
  /** speech only — who spoke (the resolved display name forwarded by the SPA). */
  speaker?: string
  /** The line text, or the card's text (a loading label while `pending`). */
  text: string
  /** card only — the signal kind (candidate/insight/caution/present/note). */
  cardType?: SignalType
  /** card only — the one-clause rationale, when present. */
  detail?: string
  /** card only — the signal correlation id (so a fill replaces its loading card). */
  id?: string
}

/** Return shape of `sync_transcript`. `cursor` is the highest `idx` in this
 *  session's log (pass it back as `since` next call); `total` is the session's
 *  full event count. `since: 0` replays the whole session (the purged-context
 *  case). */
export interface SyncTranscriptResult {
  events: EventLine[]
  cursor: number
  total: number
}

// --- Sessions index (the system-of-record list, v6 — PRD 011) ---------------

/** One row of the per-user sessions index — what the SPA lists and reloads from
 *  the backend instead of from IndexedDB. */
export interface SessionMeta {
  sessionId: string
  title: string
  createdAt: number
  lastActivity: number
  lineCount: number
  ended: boolean
}

/** Return shape of `wait_for_transcript` — the heartbeat of the loop. */
export interface WaitResult {
  lines: TranscriptLine[]
  cursor: number
  session_ended: boolean
  idle: boolean
}

export interface SessionStatus {
  protocol_version: number
  /** Which front door drives this gateway (PRD 018, additive). Stamped by the
   *  gateway health face, NOT by the session itself — absent means
   *  `classifier` (older gateways / the hosted SessionDO). In `drain` mode the
   *  read-receipt cursor is `delivered`, not `classified`, and `reflex_ready`
   *  carries no weight. */
  mode?: BridgeMode
  /** The current round's id (PRD 011) — minted at GetSessionUrl, carried in the
   *  paired URL, and the key the durable event log + sessions index use. */
  session_id: string
  transcript_lines: number
  delivered: number
  signals_sent: number
  session_ended: boolean
  /** How far the reflex has classified (heard) the transcript — the read-receipt
   *  cursor in v5, since the reflex (not the agent) is what hears the room. */
  classified: number
  /** True when the gateway's mandatory Haiku reflex is wired (a server-side
   *  ANTHROPIC_API_KEY is present). In v5 the reflex is the sole classifier, so
   *  false means the round HARD-FAILS (GetSessionUrl refuses) — the web app reads
   *  this to surface a clear "set a key" error rather than waiting silently. */
  reflex_ready: boolean
  /** True when a deliberate agent (the user's Claude Code) is attached to this
   *  round: it has parked on WaitForDelegation, has a delegation in flight, or
   *  called the heartbeat within the staleness window. Lets the web app show
   *  whether a real Claude Code is connected vs. running on the reflex alone. */
  agent_connected: boolean
  /** True when the agent has a delegation in flight (it took work and hasn't come
   *  back to park). `agent_connected && agent_working` ⇒ "working"; connected and
   *  not working ⇒ "listening". */
  agent_working: boolean
}

// --- HTTP face wire shapes (web ↔ gateway) ----------------------------------

export interface SignalsResponse {
  signals: Signal[]
  total: number
}

// --- Debug channel (gateway → web, observability only) ----------------------
// A verbose, side-channel stream of what the gateway is doing — primarily the
// reflex layer's decisions, which otherwise live entirely in Node and are
// invisible to the browser. Drained over GET /bridge/debug (SSE + buffered poll
// fallback, like /bridge/signals). Purely additive and observational: nothing
// in the response path depends on it, so it carries no PROTOCOL_VERSION weight.

export type DebugEventKind =
  | 'transcript' // a transcript batch landed at the gateway
  | 'classify' // the reflex fired a classify call (or scheduled/skipped one)
  | 'verdict' // the classifier returned (act/silent + why)
  | 'delegate' // the reflex handed real work to the deliberate model
  | 'signal' // a signal was emitted to the room
  | 'wait' // the agent drain parked / woke / drained
  | 'lifecycle' // reset / end / arm
  | 'params' // the live reflex params changed
  | 'error' // something failed

export interface DebugEvent {
  /** Monotonic per-session sequence (the resume cursor, like a signal idx). */
  seq: number
  t: number
  kind: DebugEventKind
  /** A one-line summary for the event log. */
  message: string
  /** Optional structured detail (latency, token counts, the verdict, …). */
  data?: Record<string, unknown>
}

/** The reflex layer's live-tunable parameters (PRD 008 §3.2). Surfaced + pushed
 *  over GET/POST /bridge/config so the Debug Panel can tune cadence mid-test. */
export interface ReflexParams {
  /** Batch rapid lines this long before firing a classify. */
  debounceMs: number
  /** Floor between classify calls (cost bound). */
  minIntervalMs: number
  /** Rolling transcript window handed to the classifier. */
  windowLines: number
  /** max_tokens for the classify call. */
  maxTokens: number
  /** The reflex model id. */
  model: string
}
