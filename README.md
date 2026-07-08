# convariance

**Put Claude Code (or any MCP agent) in your live conversation.**

convariance is the engine for an AI participant that *listens*: a live
transcript streams in, the agent hears it, and typed inline contributions —
ideas, insights, cautions, direct answers — flow back into the room while
people are still talking. It powers
[Convariance Cloud](https://www.convariance.com), and this repo is the whole
transport/sequencing core, open for you to build on.

```
 mic / typing ──▶ web UI (bundled) ──▶ convariance agent ──▶ Claude Code
 Web Speech API     sentence forwarding    one Node process      parks on a
 in your browser    SSE drain, receipts    stdio MCP + HTTP      blocking wait,
                          ▲                     │                zero tokens
                          └── typed signals ◀───┘                while idle
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
stream back inline while you talk. No API keys needed.

## How it works

One npm package, three layers:

- **The agent** (`convariance/agent`, run by `npx convariance`) is one Node
  process with two faces sharing one in-memory session: a **stdio MCP server**
  your agent connects to, and a **loopback HTTP face** that serves the bundled
  web UI and the bridge routes (`POST /bridge/transcript` in,
  `GET /bridge/signals` SSE out). The agent parks in a blocking wait tool at
  zero token cost until there is something to hear.
- **The client** (`createBridgeClient` from `convariance`) is a
  dependency-free browser SDK: push transcript segments in, and it forwards
  each completed **sentence** the moment it closes (a tail-idle backstop
  catches the speaker's last words; a partial that names the AI is forwarded
  immediately). Signals drain back over SSE with a poll fallback,
  idempotently, and surface as typed events — your app owns rendering.
- **The core** (also `convariance`) is the zero-dependency heart both sides
  share: the versioned wire protocol, the `BridgeSession` state machine
  (transcript/signal/delegation queues, a durable append-only event log), the
  pluggable `Classifier` seam, and a sub-speaker segmenter that turns a
  monologue into readable segments.

Two front-door modes, chosen by configuration:

| Mode | What hears the room | Needs an API key |
|---|---|---|
| **direct-drain** (default) | your agent, via `WaitForTranscript` | no |
| **classifier** | a pluggable `Classifier` that filters/delegates, agent parks on `WaitForDelegation` | whatever your classifier needs |

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
(`PROTOCOL_VERSION`, currently **6**) and reported by `/bridge/health`. This
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

[Apache-2.0](LICENSE). convariance is the open-source engine behind
[Convariance Cloud](https://www.convariance.com), the hosted product.
