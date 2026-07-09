// The bridge's tooling, defined once as silkweave Actions and deployed across
// transports (PRD 007). The agent set rides the stdio MCP adapter (Claude Code
// pulls transcript / pushes signals); the browser set rides the Fastify adapter
// (the web app pushes transcript and drains signals over SSE). Both read the one
// shared BridgeSession from context — the actions themselves are transport-blind.
//
// Naming: silkweave's stdio adapter PascalCases action names into MCP tool names
// (`send-signal` → `SendSignal`), so the agent tools surface as WaitForDelegation
// (or WaitForTranscript in drain mode — PRD 018) / SendSignal / SessionStatus /
// SyncTranscript / GetSessionUrl. The browser actions get explicit
// REST routes under /bridge/* (kept off the MCP face by living on a separate
// silkweave instance — see gateway.ts).

import { createAction } from '@silkweave/core'
import { z } from 'zod/v4'
import type { BridgeSession } from '../core/index.ts'
import type {
  BridgeMode,
  ReflexParams,
  SignalInput,
  SignalType
} from '../core/index.ts'
import { SIGNAL_TYPES } from '../core/index.ts'

/** Read / patch the live reflex params; null when no reflex is wired. */
export interface ReflexConfig {
  get(): ReflexParams | null
  set(partial: Partial<ReflexParams>): ReflexParams | null
}

// Context keys (set in gateway.ts via .set()).
const SESSION = 'session'
/** () => Promise<{ baseUrl }> — lazily binds the HTTP face (picking a free port)
 *  and resolves to its loopback base, e.g. http://127.0.0.1:7700. Calling this
 *  is what starts the server, so an idle session never squats a port. */
const ENSURE = 'ensureHttpFace'
/** the pairing token */
const TOKEN = 'bridgeToken'
/** (url) => void — opens the browser if local; no-op on remote/headless. */
const OPEN = 'openBrowser'
/** { get, set } — read / patch the live reflex params, or null when no reflex
 *  is wired (no key). Backs GET/POST /bridge/config (the Debug Panel). */
const CONFIG = 'reflexConfig'
/** BridgeMode — which front door this gateway runs (PRD 018): 'classifier'
 *  (the v5 sole-classifier loop) or 'drain' (no classifier — the agent hears
 *  the room itself via WaitForTranscript). Absent = classifier. */
const MODE = 'bridgeMode'
/** The web-app route GetSessionUrl builds the paired launch URL onto (the
 *  page that reads ?session/?title + #token). Absent = '/app/session'. */
const SESSION_PATH = 'sessionPath'

const refSchema = z.array(z.object({ seg: z.number() })).optional()

const signalChunk = z.object({
  idx: z.number(),
  type: z.enum([...SIGNAL_TYPES] as [SignalType, ...SignalType[]]),
  text: z.string(),
  detail: z.string().optional(),
  confidence: z.number().optional(),
  ref: refSchema,
  payload: z.unknown().optional(),
  id: z.string().optional(),
  pending: z.boolean().optional(),
  queued: z.boolean().optional(),
  speak: z.boolean().optional(),
  t: z.number()
})

const debugChunk = z.object({
  seq: z.number(),
  t: z.number(),
  kind: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional()
})

// The steering levers (v7 — PRD 019), shared by both config writers.
const steeringFields = {
  directive: z
    .string()
    .max(500)
    .optional()
    .describe(
      'A steering paragraph appended to the classifier\'s base prompt ' +
      '("be more generous with insights", "sensitive topic — flag risks ' +
      'aggressively"). Empty string clears it. Max 500 chars.'
    ),
  sensitivity: z
    .enum(['quiet', 'balanced', 'eager'])
    .optional()
    .describe('Coarse eagerness preset: quiet | balanced (default) | eager.')
}

const cadenceFields = {
  debounceMs: z.number().optional().describe('Batch rapid lines this long before classifying (ms).'),
  minIntervalMs: z.number().optional().describe('Floor between classify calls (ms).'),
  windowLines: z.number().optional().describe('Rolling transcript window size (lines).'),
  maxTokens: z.number().optional().describe('max_tokens for the classify call.')
}

// Partial reflex params (POST /bridge/config). All optional — patch semantics.
// The browser face keeps `model` (the Debug Panel on a user-keyed local
// gateway); the agent-facing configure-reflex tool deliberately omits it.
const reflexParamsSchema = z.object({
  ...cadenceFields,
  ...steeringFields,
  model: z.string().optional().describe('The reflex model id.')
})

function getSession(ctx: { get: <T>(k: string) => T }): BridgeSession {
  return ctx.get<BridgeSession>(SESSION)
}

function getConfig(ctx: { getOptional: <T>(k: string) => T | undefined }): ReflexConfig | undefined {
  return ctx.getOptional<ReflexConfig>(CONFIG)
}

function getMode(ctx: { getOptional: <T>(k: string) => T | undefined }): BridgeMode {
  return ctx.getOptional<BridgeMode>(MODE) ?? 'classifier'
}

// --- agent face (MCP over stdio) --------------------------------------------

// Drain mode only (PRD 018): the agent's transcript heartbeat — the pre-v5
// loop, for a gateway running with no classifier. The agent hears the room
// itself and decides its own reactions.
const WaitForTranscript = createAction({
  name: 'wait-for-transcript',
  description:
    'Block until new transcript lines arrive (or until max_wait_seconds ' +
    'elapses), then return them. This is the heartbeat of your loop: call it, ' +
    'park here at zero token cost until the room says something, react to the ' +
    'lines that come back, then call it again. YOU are the room\'s front ' +
    'door — decide for yourself what deserves a reaction, and send a signal ' +
    'only when it clearly helps (precision over recall; most batches deserve ' +
    'silence). Returns { lines, messages, cursor, session_ended, idle }. ' +
    '`messages` are TYPED asks from the room\'s UI — each is a direct request ' +
    'to you; always answer one (a `present` signal, pending + fill if it needs ' +
    'work). When idle is true nothing arrived — check any timed reminders, ' +
    'then call again. Stop when session_ended (send a closing note first).',
  disposition: 'json',
  input: z.object({
    max_wait_seconds: z
      .number()
      .optional()
      .describe('Max seconds to block (default 25, capped by the gateway).')
  }),
  run: async ({ max_wait_seconds }, ctx) =>
    getSession(ctx).waitForTranscript(max_wait_seconds)
})

const WaitForDelegation = createAction({
  name: 'wait-for-delegation',
  description:
    'Block until the fast reflex layer hands you work to do (or until ' +
    'max_wait_seconds elapses; park at 30), then return it. This is the ' +
    'heartbeat of your loop: call it, park here at zero token cost, handle ' +
    'what comes back, then call it again. You do NOT listen to raw speech — ' +
    'the reflex is the room\'s front door. ' +
    'Returns { delegations, messages, digest, session_ended, idle }. ' +
    'It hands you AT MOST ONE delegation per call (handle it, then call again ' +
    'for the next) — the queue is sequenced, and newer work that supersedes a ' +
    'still-queued item replaces it before you ever see it. Each delegation is ' +
    '{ id, task, label }: do `task`, then send a `present` signal with the ' +
    'SAME `id` (no pending) to fill the loading card the room already sees. ' +
    '`messages` are TYPED asks from the room\'s UI (the side channel) — each ' +
    'is a direct request to you; always answer one with a `present` (open a ' +
    'pending card + fill it if the ask needs real work). ' +
    '`digest` is your AMBIENT AWARENESS: what the room said since your last ' +
    'wake, what the reflex decided (incl. its silent verdicts and any ' +
    'agent_note recommendations), and the reflex config when it changed. Read ' +
    'it every wake — you MAY act on it (a signal, proactive research the user ' +
    'asked for) even with no delegation, but with restraint: the reflex is ' +
    'still the reactive front door, so do not answer things it already ' +
    'handled. `digest.truncated` means you missed more — use SyncTranscript. ' +
    'When idle is true there is no work (a digest may still be attached) — ' +
    'review it, check any timed reminders, then call again. Stop when ' +
    'session_ended (send a closing note first).',
  disposition: 'json',
  input: z.object({
    max_wait_seconds: z
      .number()
      .optional()
      .describe('Max seconds to block (default 25, capped by the gateway).')
  }),
  run: async ({ max_wait_seconds }, ctx) =>
    getSession(ctx).waitForDelegation(max_wait_seconds)
})

// The agent's steering lever on the reflex (v7 — PRD 019). Deliberately
// omits `model` (on a hosted deployment classify calls run on the operator's
// key; the local Debug Panel keeps model via POST /bridge/config).
const ConfigureReflex = createAction({
  name: 'configure-reflex',
  description:
    'Steer the fast reflex layer (the room\'s front-door classifier) at ' +
    'runtime — patch semantics, only the fields you pass change. Use it when ' +
    'the user asks to change the AI\'s behavior: "be more responsive" → ' +
    'sensitivity "eager"; "be extra careful, sensitive topic" → sensitivity ' +
    '"quiet" and/or a directive; "suggest talking points proactively" → a ' +
    'directive saying so. `directive` is a short steering paragraph appended ' +
    'to the reflex\'s prompt; `sensitivity` is a coarse eagerness preset. ' +
    'After changing it, confirm to the room with a short card. Change ' +
    'sparingly — a directive change costs a prompt-cache rewrite; never churn ' +
    'it per utterance. Returns { params } = the full effective config (null ' +
    'when this gateway runs no classifier).',
  disposition: 'json',
  input: z.object({ ...steeringFields, ...cadenceFields }),
  run: async (input, ctx) => {
    const config = getConfig(ctx)
    const params = config?.set(input as Partial<ReflexParams>) ?? null
    if (params) getSession(ctx).notifyParamsChanged(params)
    return { params }
  }
})

const SendSignal = createAction({
  name: 'send-signal',
  description:
    'Send one signal to the room (the web session). It renders INLINE in the ' +
    'transcript immediately — there is no floor to ask for and no confirm step. ' +
    'Use sparingly: precision over recall, most batches deserve silence. Kinds: ' +
    '"candidate" (a light idea), "insight" (a connection the room may have ' +
    'missed), "caution" (a concrete risk), "note" (status / closing summary), ' +
    '"present" (a direct contribution / your answer to a direct address). To ' +
    'answer something that needs work, send a "present" with pending:true and an ' +
    'id (text = a short label like "Researching market size…") to open a loading ' +
    'card, then send another "present" with the SAME id (text = the result) to ' +
    'fill it. "graph" carries a knowledge-graph delta in payload.',
  disposition: 'json',
  input: z.object({
    type: z
      .enum([...SIGNAL_TYPES] as [SignalType, ...SignalType[]])
      .describe('The signal kind (see above).'),
    text: z
      .string()
      .describe('One line — what to surface (or the loading label when pending).'),
    detail: z.string().optional().describe('Optional one-clause rationale.'),
    confidence: z.number().optional().describe('Optional 0..1.'),
    ref: refSchema.describe('Optional transcript provenance: [{ seg }].'),
    payload: z.unknown().optional().describe('Optional payload (e.g. graph delta).'),
    id: z
      .string()
      .optional()
      .describe('Correlation id: reuse it to complete a pending card you opened.'),
    pending: z
      .boolean()
      .optional()
      .describe('True to open a loading card; complete it later with the same id.'),
    speak: z
      .boolean()
      .optional()
      .describe(
        'Read this aloud in the room? true = speak it (keep it SHORT — a spoken ' +
        'sentence, seconds not minutes); false = do not speak (a link, an ' +
        'artifact handoff, or any long text). Omit to use the room default.'
      )
  }),
  run: async (input, ctx) => {
    const signal = getSession(ctx).addSignal(input as SignalInput)
    ctx.getOptional<{ info?: (m: string) => void }>('logger')?.info?.(
      `SIGNAL ${signal.type} ${JSON.stringify(signal.text)}`
    )
    return { ok: true, idx: signal.idx }
  }
})

const SessionStatus = createAction({
  name: 'session-status',
  description:
    'Cheap counters for your own bookkeeping: transcript length, lines ' +
    'delivered, signals sent, whether the session has ended.',
  disposition: 'json',
  input: z.object({}),
  run: async (_input, ctx) => getSession(ctx).status()
})

const SyncTranscript = createAction({
  name: 'sync-transcript',
  description:
    'Pull the durable transcript-of-record incrementally. The log is one ' +
    'append-only stream of EVERYTHING — every line of room speech AND every AI ' +
    'card — interleaved under a monotonic `idx`. Pass `since` = the last `cursor` ' +
    'you got (0 the first time); you get back ONLY the events after it, plus the ' +
    'new `cursor` and the session `total`. Mirror the returned events to your ' +
    'local JSONL (one per line, each carries its `idx`) and grep THAT for recall ' +
    '("what did we decide about pricing?", "summarize the meeting") — do not ' +
    're-pull the whole thing. `since: 0` replays the entire session, so after a ' +
    'context purge you can rebuild your file from scratch. Each event is ' +
    '{ idx, t, kind, speaker?, text, cardType?, detail?, id }: kind "speech" is a ' +
    'room line (speaker + text); kind "card" is an AI contribution (cardType + ' +
    'text).',
  disposition: 'json',
  input: z.object({
    since: z
      .number()
      .int()
      .optional()
      .default(0)
      .describe('Resume cursor: only events with idx > since (0 = full replay).'),
    session_id: z
      .string()
      .optional()
      .describe('Which session to read (defaults to the live round).')
  }),
  run: async ({ since, session_id }, ctx) => {
    const session = getSession(ctx)
    // One in-memory session per gateway: a stale/foreign id must fail loudly
    // rather than silently answering with the live round's events.
    if (session_id && session_id !== session.getSessionId()) {
      throw new Error(
        `unknown session ${session_id} — this gateway serves only the live ` +
          `round (${session.getSessionId()})`
      )
    }
    return session.eventsSince(since)
  }
})

const GetSessionUrl = createAction({
  name: 'get-session-url',
  description:
    'START a convariance session: call this once when the user asks to begin ' +
    '(e.g. "start a convariance session", "join my conversation"). It boots ' +
    'the local web server (on the first free port) and opens the bundled web ' +
    'UI in the user\'s browser via a loopback URL with the pairing token (and ' +
    'optional title) embedded — the page auto-pairs and starts recording ' +
    '(mic via the Web Speech API where available; typing always works). ' +
    'Nothing runs until you call this. After it returns, park on the wait ' +
    'tool to hear the room. On a remote/headless machine it does not open a ' +
    'window; show the returned url. To JOIN a session the user already has ' +
    'open in the web app (two-way connect: they gave you its id), pass it as ' +
    '`session_id` — you attach to that live round instead of starting a new ' +
    'one, and the user does not need to open the returned url.',
  disposition: 'json',
  input: z.object({
    title: z
      .string()
      .optional()
      .describe('Optional session name, shown (and editable) in the web app.'),
    session_id: z
      .string()
      .optional()
      .describe('Join this existing session (two-way connect) instead of starting a new round.')
  }),
  run: async ({ title, session_id }, ctx) => {
    const session = getSession(ctx)
    // Classifier mode (v5): the classifier is the sole front door and
    // mandatory. When its factory returned null (no server-side key) the round
    // HARD-FAILS here (before binding a port) rather than open a room whose AI
    // can never react. Drain mode has no classifier to gate on — the agent
    // itself hears the room (PRD 018).
    if (getMode(ctx) === 'classifier' && !session.isReflexReady) {
      return {
        error:
          'This gateway runs in classifier mode but its classifier is not ' +
          'ready (most commonly a missing server-side API key in the gateway ' +
          'environment / .env). Fix the classifier\'s requirements and start ' +
          'the session again.'
      }
    }
    // A new launch starts a fresh round: clear any prior round's transcript /
    // signals and lift a stale `ended` flag (the room may have left a previous
    // session, which ends it). Without this a second launch on the same
    // Claude Code process would see a permanently-ended session and exit at once.
    // With a session_id it JOINS that round instead (two-way connect) — adopt is
    // a no-op when the browser's live round already carries the id.
    if (session_id) session.adopt(session_id)
    else session.reset()
    // Booting the HTTP face is deferred to here so an idle Claude Code session
    // never opens a server or claims a port (gateway.ts ensureHttpFace).
    const ensure = ctx.get<() => Promise<{ baseUrl: string }>>(ENSURE)
    const { baseUrl } = await ensure()
    const token = ctx.get<string>(TOKEN)
    // Carry the freshly-minted round id so the SPA pairs to this exact session
    // (autopair reads ?session) — the key the durable log + sessions index use.
    // The pairing token rides in the URL fragment so it never reaches the server.
    const params = new URLSearchParams({ session: session.getSessionId() })
    if (title) params.set('title', title)
    const sessionPath = ctx.getOptional<string>(SESSION_PATH) ?? '/app/session'
    const url = `${baseUrl}${sessionPath}?${params.toString()}#token=${encodeURIComponent(token)}`
    // Joining a live round: the room is already open on the user's screen, so
    // don't pop a second browser window at them.
    const open = ctx.getOptional<(u: string) => boolean>(OPEN)
    const opened = session_id ? false : open ? open(url) : false
    return {
      url,
      opened,
      session_id: session.getSessionId(),
      joined: Boolean(session_id)
    }
  }
})

/** The agent tool set for a gateway mode (PRD 018): classifier mode parks the
 *  agent on WaitForDelegation (the reflex is the front door); drain mode hands
 *  it WaitForTranscript instead (the agent hears the room itself). */
export function agentActionsFor(mode: BridgeMode) {
  return [
    mode === 'drain' ? WaitForTranscript : WaitForDelegation,
    SendSignal,
    SessionStatus,
    SyncTranscript,
    GetSessionUrl,
    // In drain mode there is no classifier — the tool then reports
    // params: null, mirroring GET /bridge/config.
    ConfigureReflex
  ]
}

// --- browser face (REST + SSE over Fastify, all under /bridge/*) ------------

const PushTranscript = createAction({
  name: 'push-transcript',
  description: 'Web app → gateway: append finalized transcript lines (or one).',
  method: 'POST',
  path: 'bridge/transcript',
  input: z.object({
    lines: z
      .array(
        z.object({
          speaker: z.string(),
          text: z.string(),
          kind: z.enum(['speech', 'control']).optional()
        })
      )
      .optional()
      .describe('A batch of transcript lines.'),
    speaker: z.string().optional().describe('Single-line speaker (if no batch).'),
    text: z.string().optional().describe('Single-line text (if no batch).'),
    kind: z
      .enum(['speech', 'control'])
      .optional()
      .describe('Single-line kind: speech, or a facilitator control line.')
  }),
  run: async (input, ctx) => {
    const session = getSession(ctx)
    const inputs = input.lines ?? [
      { speaker: input.speaker ?? 'Speaker', text: input.text ?? '', kind: input.kind }
    ]
    const added = session.pushTranscript(inputs)
    return { ok: true, added: added.length, total: session.status().transcript_lines }
  }
})

// Browser → gateway session-id sync (two-way connect): the SPA declares which
// session its live round belongs to, so the event log keys on the SPA's own id
// and a later join by id finds the round already keyed right.
// Same id = no-op; a different id starts a clean round under it.
const AdoptSession = createAction({
  name: 'adopt-session',
  description:
    'Web app → gateway: bind the live round to the SPA\'s session id (and ' +
    'optionally its title). Idempotent for the current id.',
  method: 'POST',
  path: 'bridge/session',
  input: z.object({
    session_id: z.string().describe('The SPA session id the live round belongs to.'),
    title: z.string().optional().describe('The session title, for the index.')
  }),
  run: async (input, ctx) => {
    const { reset } = getSession(ctx).adopt(input.session_id)
    return { ok: true, reset }
  }
})

const PushHistory = createAction({
  name: 'push-history',
  description:
    'Web app → gateway: hand over a resumed session\'s restored prior-round ' +
    'transcript. Stored in a passive archive read on demand ' +
    '(session.getTranscript()) — never drained into the live ' +
    'wait_for_transcript stream.',
  method: 'POST',
  path: 'bridge/history',
  input: z.object({
    lines: z
      .array(
        z.object({
          speaker: z.string(),
          text: z.string(),
          kind: z.enum(['speech', 'control']).optional()
        })
      )
      .describe('The restored transcript lines, oldest→newest.')
  }),
  run: async (input, ctx) => {
    const stored = getSession(ctx).setArchive(input.lines)
    return { ok: true, stored }
  }
})

const DrainSignals = createAction({
  name: 'drain-signals',
  description:
    'Web app → gateway: drain signals with idx >= since. With Accept: ' +
    'text/event-stream it streams live over SSE until the session ends; ' +
    'otherwise it returns the backlog as a JSON array (the poll fallback).',
  kind: 'query',
  path: 'bridge/signals',
  queryParams: ['since'],
  input: z.object({
    since: z
      .number()
      .int()
      .optional()
      .default(0)
      .describe('Resume point: only signals with idx >= since.')
  }),
  chunk: signalChunk,
  run: async function* ({ since }, ctx) {
    const session = getSession(ctx)
    for (const s of session.signalsSince(since)) yield s
    // Poll callers (no SSE) get the backlog as a buffered array and return now;
    // SSE callers keep the connection open and receive live signals.
    const req = ctx.getOptional<{ headers: Record<string, string | undefined> }>(
      'request'
    )
    const accept = req?.headers?.accept ?? ''
    if (!accept.includes('text/event-stream')) return
    yield* session.liveSignals()
  }
})

// The typed side channel (v7 — PRD 019): a deliberate ask from the room's UI,
// straight to the agent — it bypasses the classifier and wakes a parked wait
// immediately. Logged as a `chat` event in the durable transcript-of-record.
const SendMessage = createAction({
  name: 'send-message',
  description:
    'Web app → gateway: a typed message to the AI participant (the side ' +
    'channel). Queued for the agent\'s next wait return, waking a parked ' +
    'waiter immediately; logged as a `chat` event.',
  method: 'POST',
  path: 'bridge/message',
  input: z.object({
    text: z.string().describe('The message text.'),
    from: z.string().optional().describe('Sender display name (default "You").')
  }),
  run: async (input, ctx) => {
    const message = getSession(ctx).postMessage(input)
    if (!message) return { ok: false as const }
    return { ok: true as const, id: message.id, t: message.t }
  }
})

const EndSession = createAction({
  name: 'end-session',
  description: 'Web app → gateway: the room closed; end the session.',
  method: 'POST',
  path: 'bridge/end',
  input: z.object({}),
  run: async (_input, ctx) => {
    getSession(ctx).end()
    return { ok: true }
  }
})

const Health = createAction({
  name: 'health',
  description:
    'Unauthenticated liveness probe: proves the gateway is up without leaking ' +
    'session content (lets the web app tell "unreachable" from "not paired").',
  kind: 'query',
  path: 'bridge/health',
  input: z.object({}),
  run: async (_input, ctx) => ({
    ok: true,
    mode: getMode(ctx),
    ...getSession(ctx).status()
  })
})

// The verbose observability stream (Debug Panel). Mirrors DrainSignals: SSE for
// the live stream, a buffered JSON array for the poll fallback, resumed by
// `since` (the per-round debug seq). Observational only.
const DrainDebug = createAction({
  name: 'drain-debug',
  description:
    'Web app → gateway: drain debug events with seq >= since. With Accept: ' +
    'text/event-stream it streams live over SSE; otherwise returns the buffered ' +
    'backlog as a JSON array. Observability only (the Debug Panel).',
  kind: 'query',
  path: 'bridge/debug',
  queryParams: ['since'],
  input: z.object({
    since: z
      .number()
      .int()
      .optional()
      .default(0)
      .describe('Resume point: only debug events with seq >= since.')
  }),
  chunk: debugChunk,
  run: async function* ({ since }, ctx) {
    const session = getSession(ctx)
    for (const e of session.debugSince(since)) yield e
    const req = ctx.getOptional<{ headers: Record<string, string | undefined> }>(
      'request'
    )
    const accept = req?.headers?.accept ?? ''
    if (!accept.includes('text/event-stream')) return
    yield* session.liveDebug()
  }
})

// Read the live reflex params (the Debug Panel's / AI-style control's initial
// state). `params` is null when no reflex is wired (no key) — the panel then
// shows the gateway params as unavailable. `rev` primes the client's
// change-watch (params_rev on health).
const GetConfig = createAction({
  name: 'get-config',
  description: 'Web app → gateway: read the live reflex params (or null).',
  kind: 'query',
  path: 'bridge/config',
  input: z.object({}),
  run: async (_input, ctx) => {
    const session = getSession(ctx)
    return { params: getConfig(ctx)?.get() ?? null, rev: session.paramsRevision }
  }
})

// Patch the live reflex params (the Debug Panel's sliders / the AI-style
// control). Applies immediately to the running classifier; returns the new
// effective params (or null). Bumps params_rev + marks the config for the
// agent's next digest, so a UI edit reaches the agent too (v7).
const SetConfig = createAction({
  name: 'set-config',
  description: 'Web app → gateway: patch the live reflex params (tune cadence / steering).',
  method: 'POST',
  path: 'bridge/config',
  input: reflexParamsSchema,
  run: async (input, ctx) => {
    const session = getSession(ctx)
    const config = getConfig(ctx)
    if (!config) return { params: null, rev: session.paramsRevision }
    const params = config.set(input as Partial<ReflexParams>)
    if (params) session.notifyParamsChanged(params)
    return { params, rev: session.paramsRevision }
  }
})

export const browserActions = [
  PushTranscript,
  AdoptSession,
  PushHistory,
  DrainSignals,
  SendMessage,
  EndSession,
  Health,
  DrainDebug,
  GetConfig,
  SetConfig
]

export const CTX_KEYS = {
  SESSION,
  ENSURE,
  TOKEN,
  OPEN,
  CONFIG,
  MODE,
  SESSION_PATH
} as const
