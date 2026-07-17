<div align="center">

<img src="https://raw.githubusercontent.com/convariance/convariance/master/docs/teaser.svg" alt="convariance: a live conversation streams in, Claude Code listens and typed contributions land back in the room" width="820">

# convariance

**Put Claude Code (or any MCP agent) in your live conversation.**

People talk. The agent *listens* — and typed contributions land in the room
while the conversation is still moving.

[![npm](https://img.shields.io/npm/v/convariance?logo=npm&color=CB3837)](https://www.npmjs.com/package/convariance)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-5FA04E?logo=nodedotjs&logoColor=white)
![Protocol](https://img.shields.io/badge/wire_protocol-v7-3423A6)
![Claude Code](https://img.shields.io/badge/Claude_Code-MCP-D97757)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

```
$ npx convariance
· registered MCP server "convariance" with Claude Code

$ claude
> join my conversation
· GetSessionUrl → your browser opens the bundled chat UI, already paired
🎙 "…okay, but what could we actually ship by Friday?"
💡 Idea — the drain-mode gateway is keyless; that ships by Friday   ← lands inline
```

## Quickstart

```sh
npx convariance
```

That's it. Run it in your project and it registers the MCP server with Claude
Code (via `claude mcp add`, or by writing `.mcp.json`). Then start Claude Code
and ask Claude to join your conversation — it calls `GetSessionUrl` and opens
the bundled chat UI in your browser, already paired. Speak (Chrome/Edge, via
the Web Speech API — no external STT service) or type; Claude's contributions
stream back inline while you talk. **No API keys, no accounts, no cloud.**

## Why

Agents are turn-based; conversations aren't. Drop an agent into a live
transcript naively and everything goes wrong at once: it burns tokens polling
a mostly-quiet room, it interrupts mid-sentence because speech arrives as
fragments, and its replies show up as a wall of text nobody reads while
talking. convariance is the transport and sequencing layer that fixes each of
those:

- **Zero tokens while idle** — the agent parks on a blocking wait
  (`WaitForTranscript`) and wakes only when there's something to hear.
- **Finished thoughts only** — the client forwards a speech card once it
  *completes* (a newer card starts, or the tail sits idle), so the agent
  reacts to whole thoughts, never fragments of one.
- **Typed, inline contributions** — signals arrive as structured cards
  (Idea / Insight / Caution / Note / present), anchorable to transcript
  segments, with per-segment delivery receipts.
- **Nothing lost, nothing doubled** — cursors make transcript and signal
  delivery idempotent across drops and reconnects; a durable append-only
  event log lets a purged-context agent replay the whole round.

## How it works

```
 mic / typing ──▶ web UI (bundled) ──▶ convariance agent ──▶ Claude Code
 Web Speech API     card-complete forward  one Node process      parks on a
 in your browser    SSE drain, receipts    stdio MCP + HTTP      blocking wait,
                          ▲                     │                zero tokens
                          └── typed signals ◀───┘                while idle
```

One npm package, three layers:

- **The agent** (`convariance/agent`, run by `npx convariance`) is one Node
  process with two faces sharing one in-memory session: a **stdio MCP server**
  your agent connects to, and a **loopback HTTP face** that serves the bundled
  web UI and the bridge routes (`POST /bridge/transcript` in,
  `GET /bridge/signals` SSE out).
- **The client** (`createBridgeClient` from `convariance`) is a
  dependency-free browser SDK: push transcript segments in, and it forwards
  each speech card once it completes. Signals drain back over SSE with a poll
  fallback, idempotently, and surface as typed events — your app owns
  rendering.
- **The core** (also `convariance`) is the zero-dependency heart both sides
  share: the versioned wire protocol, the `BridgeSession` state machine
  (transcript/signal/delegation queues, the durable event log), the pluggable
  `Classifier` seam, and a sub-speaker segmenter that turns a monologue into
  readable segments.

Two front-door modes, chosen by configuration:

| Mode | What hears the room | Needs an API key |
|---|---|---|
| **direct-drain** (default) | your agent, via `WaitForTranscript` | no |
| **classifier** | a pluggable `Classifier` that filters/delegates; the agent parks on `WaitForDelegation` | whatever your classifier needs |

## The MCP tools

What the agent sees once connected:

| Tool | What it does |
| --- | --- |
| `GetSessionUrl` | Boots the HTTP face, starts (or joins) a round, returns the paired launch URL — and opens the browser. |
| `WaitForTranscript` / `WaitForDelegation` | The heartbeat: a blocking wait that returns new lines or delegations, `idle` on a quiet wake, `session_ended` when the round is over. |
| `SendSignal` | A typed contribution: `candidate` / `insight` / `caution` / `note` / `present`, optionally anchored to transcript segments; can fill a `pending` card opened earlier. |
| `SessionStatus` | Cursors, liveness, mode — the status snapshot. |
| `SyncTranscript` | Incremental read of the durable event log; `since: 0` replays the round (the purged-context recovery path). |
| `ConfigureReflex` | Steer the classifier at runtime: a bounded `directive` paragraph and a `sensitivity` level (`quiet` / `balanced` / `eager`). |

## The SDK

```ts
// browser / worker / Node — zero dependencies
import { createBridgeClient, parseLaunchParams, BridgeSession } from 'convariance'

const client = createBridgeClient({ endpoint, token, session })
client.on('turn', (turn) => render(turn))        // typed AI contributions
client.on('status', (s) => console.log(s))       // semantic session state
client.activate()
client.pushSegments(segments)                    // your STT's output

// Node only — run your own gateway (custom Classifier, custom UI bundle)
import { startGateway, createStaticHandler } from 'convariance/agent'

await startGateway({ classifier: myClassifierFactory })
```

| Export | What | Runs in |
|---|---|---|
| `convariance` | protocol, `BridgeSession`, `Classifier` seam, segmenter, `createBridgeClient`, launch-URL pairing | Node, workerd, browsers |
| `convariance/agent` | `startGateway` (stdio MCP + HTTP/SSE), static handler, pairing runtime | Node ≥ 20 |
| `npx convariance` | the runnable agent: setup in a terminal, serve under an MCP client | Node ≥ 20 |

Or poke the gateway with nothing but `curl`:

```sh
BRIDGE_EAGER=1 BRIDGE_TOKEN=dev npx -y convariance serve &
curl -X POST http://127.0.0.1:7700/bridge/transcript \
  -H 'content-type: application/json' -H 'x-bridge-token: dev' \
  -d '{"speaker": "Ada", "text": "What could we ship by Friday?"}'
```

## Environment

| Var | Effect |
|---|---|
| `BRIDGE_PORT` | first port to try (default 7700) |
| `BRIDGE_HOST` | bind host (default `127.0.0.1`) |
| `BRIDGE_TOKEN` | fixed pairing token (default: minted per process) |
| `BRIDGE_DIST` | serve a custom UI bundle instead of the packaged one |
| `BRIDGE_ALLOWED_ORIGINS` | comma-separated CORS allowlist for an externally hosted UI |
| `BRIDGE_MAX_BLOCK_SEC` | blocking-wait cap (default 50) |
| `BRIDGE_EAGER=1` | boot the HTTP face at startup (curl/standalone runs) |
| `BRIDGE_NO_OPEN=1` | never auto-open a browser |
| `BRIDGE_NO_ENV=1` | skip loading a local `.env` |

## Protocol and stability

The wire protocol is versioned separately from the package
(`PROTOCOL_VERSION`, currently **7**) and reported by `/bridge/health`. This
package is **pre-1.0**: the API may move between minor versions, and a
protocol bump is a minor version with the wire impact called out in the
changelog. Protocol changes stay maintainer-driven until 1.0
([CONTRIBUTING](CONTRIBUTING.md)).

## Development

```sh
pnpm install
pnpm check     # typecheck + lint
pnpm test      # unit tests (node --test, runs straight from source)
pnpm smoke     # spawns a real gateway and exercises the whole protocol
pnpm build     # tsdown (dist/) + vite (dist/ui)
pnpm gateway   # run the agent from source (serve mode)
pnpm dev       # the web UI on :5173 against a live gateway
```

No build step is needed for development — Node runs the TypeScript source
directly (type stripping), and the UI dev server compiles against source.

Deep-dives live in [`docs/`](docs): the [wire protocol](docs/protocol.md),
the [gateway & client architecture](docs/architecture.md), and
[building & releasing](docs/releasing.md).

## License

[Apache-2.0](LICENSE)
