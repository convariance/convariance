# The wire protocol

The protocol is the contract between the three parties in a live session: the
**web app** (browser, via the `convariance` client SDK), the **gateway** (one local
Node process), and the **agent** (Claude Code over MCP stdio). It is versioned
separately from the package: `PROTOCOL_VERSION` (currently **6**) lives in
`src/core/protocol.ts` and is reported by `GET /bridge/health`, so
either side can detect a mismatch. All changes so far have been additive.

## Version history

| v | Change |
|---|--------|
| 1 | Sentence-level transcript in, typed signals out, `seg`-anchored refs |
| 2 | The `address` signal (direct address extraction) |
| 3 | Signal `id` + `pending` — loading cards a later signal completes |
| 4 | On-demand history: `POST /bridge/history` into a passive archive |
| 5 | Delegations (sole-classifier front door): the reflex classifies every line, the agent parks on `wait_for_delegation` |
| 6 | The transcript becomes a **durable, append-only event log** (`sync_transcript`, real session ids, sessions index); the local gateway additionally grew the **mode** flag (drain vs classifier) with the open-source split |

## Two front-door modes

Health stamps `mode`; absent means `classifier` (older gateways / hosted
deployments).

| Mode | What hears the room | Agent parks on | Read-receipt cursor |
|---|---|---|---|
| `drain` (shipped bin default) | the agent itself | `WaitForTranscript` | `delivered` |
| `classifier` | a pluggable `Classifier` (mandatory once configured — a not-ready classifier hard-fails `GetSessionUrl`) | `WaitForDelegation` | `classified` |

## The agent face (MCP tools, PascalCase)

- **`GetSessionUrl`** — boots the lazy HTTP face (first free port from 7700),
  resets to a fresh round (or **joins** an existing one when `session_id` is
  passed — two-way connect), and returns the paired launch URL. Auto-opens a
  browser locally unless joining / `BRIDGE_NO_OPEN=1` / headless.
- **`WaitForTranscript`** (drain) / **`WaitForDelegation`** (classifier) — the
  heartbeat: a blocking wait (default cap 50 s, `BRIDGE_MAX_BLOCK_SEC`) that
  returns new lines / delegations, `idle: true` on a quiet wake, and
  `session_ended` when the round is over. The agent parks here at zero token
  cost.
- **`SendSignal`** — a typed contribution: `candidate` / `insight` / `caution` /
  `note` / `present` (+ `graph`, payload-typed). Optional `ref` anchors to
  transcript `seg`s; an `id` fills a `pending` card opened earlier.
- **`SessionStatus`** — the status snapshot (cursors, liveness, mode).
- **`SyncTranscript`** — incremental read of the durable event log:
  `{ since } → { events, cursor, total }`, `since: 0` replays the round (the
  purged-context recovery path). A `session_id` that is not the live round is
  an **error** (one in-memory session per gateway).

## The HTTP face (`/bridge/*`)

Token-gated (see auth below); everything else on the port is the optional
static UI.

| Route | Direction | What |
|---|---|---|
| `POST /bridge/transcript` | web → gateway | one finalized line `{ speaker, text, kind?: 'speech' \| 'control' }` |
| `GET /bridge/signals?since=N` | gateway → web | signals with `idx >= since`; plain GET polls, `Accept: text/event-stream` opens the live SSE drain |
| `POST /bridge/session` | web → gateway | adopt: key the live round by the SPA's own session id (no-op when it already matches) |
| `POST /bridge/history` | web → gateway | restored prior-round lines into the **passive archive** (never enters the live stream — resume without re-reacting) |
| `POST /bridge/end` | web → gateway | end the round; the agent's wait returns `session_ended` |
| `GET /bridge/health` | web → gateway | protocol version, mode, cursors, reflex/agent liveness |
| `GET /bridge/debug` | gateway → web | observability side-channel (SSE + poll), classifier decisions etc. |
| `GET/POST /bridge/config` | web ↔ gateway | live-tunable classifier params (`null` without a classifier) |

Delivery is **idempotent by cursor**: signals carry a monotonic 1-based `idx`,
transcript lines a monotonic `seg`; readers resume from their cursor after any
drop, so nothing is lost or duplicated.

## Auth and pairing

- The gateway mints a URL-safe bearer token at startup (`BRIDGE_TOKEN`
  overrides). Every `/bridge/*` request must carry it — `x-bridge-token`
  header, or `?token=` in the query for `EventSource` (which cannot set
  headers).
- Browser requests are additionally origin-gated: same-origin (the packaged
  UI's case) + Vite dev origins by default, `BRIDGE_ALLOWED_ORIGINS`
  (comma-separated) wins verbatim — that is how an externally-hosted UI is
  allowed in.
- **Launch URL**: `http://127.0.0.1:<port><sessionPath>?session=<id>&title=…#token=<t>`.
  The token rides the **fragment** so it never reaches a server or its logs;
  `?session` keys the durable log. The `convariance` client SDK ships the pure parser
  (`parseLaunchParams`) and `consumeLaunchParams()` (parses + strips the
  address bar).

## The turn lifecycle (how signals render)

The `convariance` client SDK derives an inline-contribution lifecycle from the signal
stream: `open` (a `pending` signal opened a loading card) → `update`
(queued/label changed) → `fill` (a signal with the same `id` completes it), or
plain `add` for terminal cards. Delivery events give per-segment `sent`
(gateway acked) / `heard` (the front door consumed it) receipts.

## Known open edge

The v4 history archive is currently **write-only**: `POST /bridge/history`
fills it and `BridgeSession.getTranscript()` reads it, but no MCP recall tool
has existed since v6 replaced `get_transcript` with `sync_transcript`. Either
a recall tool returns or the path gets removed — tracked as an open decision.
