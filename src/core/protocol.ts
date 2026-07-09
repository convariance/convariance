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
// archive read on demand (`BridgeSession.getTranscript()`; the v4 MCP recall
// tool was retired by v6's sync_transcript) — it is never fed into the
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
// sessions can be listed / reloaded / deleted (the sessions index), and a
// hosted deployment can persist the log durably so it survives eviction and a
// context purge. The SPA becomes the read client (server is the system of record).
// PRD 018 (the open-source core split) adds the gateway MODE, additively: a
// gateway configured WITHOUT a classifier runs in `drain` mode — the agent
// hears the room itself via `wait_for_transcript` (the pre-v5 loop, which never
// left the session core), GetSessionUrl does not gate on `reflex_ready`, and
// `delivered` (not `classified`) is the read-receipt cursor. Health stamps
// `mode`; absent = `classifier` (older gateways / hosted deployments).
// v7 (PRD 019 — comms) gives the agent ambient awareness and the room a typed
// side channel, all riding the existing heartbeat:
//   - every wait return may carry a `digest` — the durable-log events since the
//     agent's last wake + the classifier's verdicts (incl. silent ones, and an
//     optional `agent_note` whisper) + the effective reflex params when they
//     changed. The agent MAY act on a digest (it is no longer structurally mute
//     when the classifier stays silent), at heartbeat cadence.
//   - typed user messages (`chat` event kind, POST /bridge/message) go straight
//     to the agent as `messages` on the wait return, waking a parked waiter
//     immediately — a deliberate ask never waits for the classifier.
//   - the reflex params are steerable by BOTH principals: `directive` +
//     `sensitivity` extend ReflexParams; the agent patches them via the new
//     configure-reflex tool, the UI via POST /bridge/config; `params_rev` on
//     status lets either side notice the other's change.
export const PROTOCOL_VERSION = 7

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
 *  WaitResult: it blocks until a delegation OR a typed message lands (or
 *  `max_wait_seconds`), so the agent still wakes on a quiet cadence to fire
 *  timed reminders / notice the session ending. `idle` true = no delegation and
 *  no message (a `digest` may still be present — ambient context, not work);
 *  `session_ended` = wrap up + stop. */
export interface WaitDelegationResult {
  delegations: Delegation[]
  /** Typed side-channel messages from the room (v7) — direct asks that bypass
   *  the classifier. Answer each like a direct address. */
  messages?: AgentMessage[]
  /** Ambient context since the agent's last wake (v7). Absent when nothing new. */
  digest?: Digest
  session_ended: boolean
  idle: boolean
}

// --- Ambient awareness: the digest + typed side channel (v7 — PRD 019) ------

/** A typed message from the room to the agent (the side channel): a deliberate
 *  ask entered in the session UI, delivered on the next wait return — waking a
 *  parked waiter immediately, not at the next heartbeat. */
export interface AgentMessage {
  id: string
  /** The sender's display name. */
  from: string
  text: string
  t: number
}

/** One classifier verdict, summarized for the agent's digest. Silent verdicts
 *  are just `{ t, act: false }` — cheap by design. `agent_note` is the
 *  classifier's optional whisper to the agent (a recommendation the room never
 *  sees: "this could use background research"). */
export interface VerdictSummary {
  t: number
  act: boolean
  type?: SignalType
  text?: string
  agent_note?: string
}

/** Ambient context attached to a wait return (v7): what happened since the
 *  agent's last wake. The agent stays informed at heartbeat cadence and MAY
 *  engage off it (send a signal, volunteer work) — with restraint; the
 *  classifier is still the room's reactive front door. */
export interface Digest {
  /** Durable-log events (speech, cards, chat) since the last wake — capped;
   *  see `truncated`. */
  events: EventLine[]
  /** The agent's new digest cursor (the log's high-water idx). */
  cursor: number
  /** True when the gap exceeded the cap: `events` is only the most recent
   *  slice — call sync_transcript for the rest. */
  truncated?: boolean
  /** Classifier verdicts since the last wake (classifier mode only). */
  verdicts: VerdictSummary[]
  /** The effective reflex params — present ONLY when they changed since the
   *  last wake (either principal), so the agent notices UI-side retuning. */
  config?: ReflexParams
}

// --- On-demand transcript history (v4) ---------------------------------------
// The read side is `BridgeSession.getTranscript()`; the v4 `get_transcript`
// MCP tool it once backed was retired by v6's sync_transcript.

/** One line returned by `getTranscript()`. Spans both the restored prior-round
 *  archive and this round's lines, oldest→newest; a reader uses these for
 *  recall, not to anchor signals (those ref the live `seg`). */
export interface HistoryLine {
  speaker: string
  text: string
  kind: 'speech' | 'control'
}

/** Return shape of `getTranscript()`. `total` is the full known line count
 *  (archive + this round) before any `limit`/`search`; `returned` is how many
 *  this call yielded. */
export interface GetTranscriptResult {
  lines: HistoryLine[]
  total: number
  returned: number
}

// --- The durable event log (sync_transcript, v6 — PRD 011) ------------------

export type EventKind = 'speech' | 'card' | 'chat'

/** One entry in the unified append-only transcript-of-record: a line of room
 *  speech (`kind: 'speech'`, `speaker` + `text`), an AI contribution
 *  (`kind: 'card'`, `cardType` + `text` [+ `detail`/`id`]), or a typed
 *  side-channel message to the agent (`kind: 'chat'`, `speaker` + `text` —
 *  v7) — interleaved in the order they happened, under one monotonic `idx`
 *  (the sync cursor). Control lines (session-config) are NOT logged. */
export interface EventLine {
  idx: number
  t: number
  kind: EventKind
  /** speech/chat — who spoke or typed (the resolved display name). */
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
  /** Typed side-channel messages (v7): in drain mode too, a typed ask wakes the
   *  parked waiter immediately and rides the return. (No `digest` here — the
   *  drain agent hears the room itself, so a digest would just duplicate
   *  `lines`.) */
  messages?: AgentMessage[]
  cursor: number
  session_ended: boolean
  idle: boolean
}

export interface SessionStatus {
  protocol_version: number
  /** Which front door drives this gateway (PRD 018, additive). Stamped by the
   *  gateway health face, NOT by the session itself — absent means
   *  `classifier` (older gateways / hosted deployments). In `drain` mode the
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
  /** Monotonic revision of the reflex params (v7): bumped on every change from
   *  either principal (the agent's configure-reflex tool, the UI's POST
   *  /bridge/config). The browser client watches it on the health poll to
   *  notice agent-side retuning. */
  params_rev?: number
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

/** Coarse steering preset for the classifier's judgment (v7): how eager it
 *  should be to surface cards. Implementations map it to both prompt language
 *  and their suppression guards. `balanced` = the default behavior. */
export type ReflexSensitivity = 'quiet' | 'balanced' | 'eager'

/** The reflex layer's live-tunable parameters (PRD 008 §3.2). Surfaced + pushed
 *  over GET/POST /bridge/config so the Debug Panel can tune cadence mid-test.
 *  v7 (PRD 019) adds the semantic levers — `directive` + `sensitivity` — and a
 *  second writer: the agent's configure-reflex tool. The classifier's base
 *  prompt stays owner-controlled; steering is additive only. */
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
  /** A steering paragraph appended to the classifier's base prompt (v7) —
   *  "be more generous with insights", "sensitive topic, flag risks
   *  aggressively". Bounded (implementations cap length); empty = none. */
  directive?: string
  /** Coarse eagerness preset (v7); absent = 'balanced'. */
  sensitivity?: ReflexSensitivity
}
