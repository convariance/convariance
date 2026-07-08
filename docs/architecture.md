# Gateway & client architecture

## One process, two faces

The gateway (`startGateway`, `src/agent/gateway.ts`) is a single
Node process holding **one in-memory `BridgeSession`** shared by two adapters:

- **stdio MCP** — starts immediately; it is how Claude Code reaches the
  gateway (launched via `.mcp.json`) and its stdin is what keeps the process
  alive. stdout is reserved for JSON-RPC; **all logging goes to stderr**.
- **Fastify HTTP** — **lazy**: no port is bound until the first
  `GetSessionUrl`. A user may run several Claude Code sessions at once (each
  spawns its own gateway), so an eager server would fight over ports; instead
  each booting session walks up from `BRIDGE_PORT` (default 7700, 64 tries)
  and binds the first free port. When the MCP client exits (stdin closes) the
  HTTP face is torn down and the port released.

The two faces MUST be one process — that is what lets them share the session.
`.mcp.json` launching the bin gives exactly that.

The HTTP server is split by a `serverFactory`: `/bridge/*` goes to Fastify
(token + Origin enforced before the handler; OPTIONS passes through for CORS
preflight; `/bridge/health` skips the origin gate), everything else goes to
the `staticHandler` (`createStaticHandler(dir, { spaPrefixes, spaShell,
missingMessage })`) or a plain 404. The shipped bin (`src/cli.ts`) always
wires a static handler: the **packaged web UI** in `dist/ui` (resolved
relative to the module, so it works from the published tarball and a source
checkout alike), or whatever `BRIDGE_DIST` points at.

## The CLI (dual-mode bin)

`npx convariance` (`src/cli.ts`) picks its mode by context: spawned over
pipes by an MCP client → **serve** (the gateway above); run from a terminal
(TTY, and `CI` unset) → **setup**, which registers the MCP server with Claude
Code (`claude mcp add`, falling back to merging `.mcp.json` in the cwd — the
only file the package ever writes). Explicit `convariance serve` /
`convariance setup` subcommands override the detection. In serve mode the CLI
never touches stdout or stdin — silkweave's stdio adapter owns both.

## Environment variables

| Var | Effect |
|---|---|
| `BRIDGE_PORT` | first port to try (default 7700) |
| `BRIDGE_HOST` | bind host (default `127.0.0.1`) |
| `BRIDGE_TOKEN` | fixed pairing token (default: minted per process) |
| `BRIDGE_DIST` | serve a custom UI bundle instead of the packaged `dist/ui` |
| `BRIDGE_ALLOWED_ORIGINS` | comma-separated CORS allowlist, wins verbatim over the same-origin + Vite-dev defaults |
| `BRIDGE_MAX_BLOCK_SEC` | blocking-wait cap (default 50 — measured safe under a 55 s tool-call ceiling) |
| `BRIDGE_EAGER=1` | boot the HTTP face at startup (standalone/curl runs where no MCP client will call `GetSessionUrl`); stdin-EOF shutdown is disabled in this mode |
| `BRIDGE_NO_OPEN=1` / `BRIDGE_OPEN=0` | never auto-open a browser |
| `BRIDGE_NO_ENV=1` | skip loading a local `.env` (`process.loadEnvFile`) — the smoke's keyless guarantee |

## Pairing runtime

`mintToken()` makes a short URL-safe bearer token; `writeInfo()` drops a
`convariance-bridge-<port>.json` info file (mode 0600) in the OS tmpdir at
HTTP boot and clears it on shutdown/exit. Dev tools (`smoke`, `dev/feed.ts`,
`dev/watch.ts`) pair automatically by reading the newest info file
(`latestInfo()`); the real web app gets the token via the launch URL instead.
The token never leaves loopback.

## BridgeSession (core)

The shared state machine (`src/core/session.ts`):

- **Blocking waits** — `WaitForTranscript` / `WaitForDelegation` park in a
  waiter until new work arrives or the cap expires (`idle: true`). This is the
  token-efficiency bet: an idle agent costs nothing.
- **The durable event log** — speech lines AND AI cards interleaved under one
  monotonic `idx`; serves `SyncTranscript` from memory locally (a hosted
  deployment can override `eventsSince` with a durable read).
- **Rounds** — `reset()` mints a fresh session id (UUID) for a new launch;
  `adopt(id)` joins/keys the round by the SPA's own id (no-op when it already
  matches). Prior rounds live in a host's durable store, not here.
- **Read receipts** — `delivered` (drain: the agent's wait consumed it) vs
  `classified` (classifier mode: the reflex consumed it).
- **Echo suppression** — `textSim.ts` (jaccard) keeps the agent's own speech
  from bouncing back as transcript.
- The **classifier seam** (`classifier.ts`): a `ClassifierFactory` gets the
  session, subscribes (`onTranscript`/`onReset`), and acts through the public
  surface (`addSignal`, `delegate`, `markClassified`). Returning `null` (e.g.
  no API key) leaves the gateway not-ready and `GetSessionUrl` hard-fails the
  round rather than opening a room whose AI can never react.

## The client (browser SDK)

`createBridgeClient` (`src/client/bridgeClient.ts`) owns the wire
discipline, and nothing else — the host app owns rendering/persistence:

- **Sentence-level forwarding**: pushed segments are split at sentence
  boundaries; completed sentences go out on the next flush (default 600 ms), a
  trailing incomplete sentence waits `tailIdleMs` (default 3200 — deliberately
  ≥ the segmenter's 3000 ms pause so a resumed utterance starts a NEW segment
  rather than double-sending). A line mentioning the trigger name (default
  "Claude") forwards immediately. Typed-chat hosts (complete messages) can
  drop these way down via `params`.
- **Lifecycle**: `activate()` (idempotent; syncs the session id, drains,
  forwards) / `setForwarding(on)` (pause without ending the round) /
  `dispose()` (POST `/bridge/end` + teardown).
- **Signals in**: SSE preferred, poll fallback, resumed by `idx` — idempotent
  across drops. Health polls (~700 ms) drive presence + `heard` receipts and
  notice a round that ended out from under us.
- **Events out**: `status` / `turn` / `presence` / `delivery` / `signal` /
  `debug` (see [protocol.md](protocol.md) for the turn lifecycle).

## Dev tools

`src/agent/dev/feed.ts` replays a transcript file into a running
gateway at speech pace (`transcript.sample.txt` documents the line format);
`dev/watch.ts` renders the signal stream the way a web UI would. Both pair via
the tmpdir info file. The protocol smoke (`test/smoke.ts`)
spawns real gateways (stub-classifier, not-ready, and drain-bin fixtures) and
drives both faces; it must pass keyless.
