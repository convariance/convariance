# convariance

**Put Claude Code (or any MCP agent) in your live conversation.**

convariance is the engine for an AI participant that *listens*: a live
transcript streams in, the agent hears it, and typed inline contributions —
ideas, insights, cautions, direct answers — flow back into the room while
people are still talking. It powers
[Convariance Cloud](https://www.convariance.com), and this repo is the whole
transport/sequencing core, open for you to build on.

```
 mic / STT ──▶ @convariance/client ──▶ @convariance/gateway ──▶ Claude Code
 (your app)      sentence forwarding      one Node process         parks on a
                 SSE drain, receipts       stdio MCP + HTTP        blocking wait,
                       ▲                       │                   zero tokens
                       └──── typed signals ◀───┘                   while idle
```

## How it works

- **The gateway** (`@convariance/gateway`) is one Node process with two faces
  sharing one in-memory session: a **stdio MCP server** your agent connects to
  (this is what you register in `.mcp.json`), and a **loopback HTTP face** for
  the browser (`POST /bridge/transcript` in, `GET /bridge/signals` SSE out).
  The agent parks in a blocking wait tool at zero token cost until there is
  something to hear.
- **The client** (`@convariance/client`) is a dependency-free browser SDK:
  push transcript segments in, and it forwards each completed **sentence** the
  moment it closes (a tail-idle backstop catches the speaker's last words; a
  partial that names the AI is forwarded immediately). Signals drain back over
  SSE with a poll fallback, idempotently, and surface as typed events — your
  app owns rendering.
- **The core** (`@convariance/core`) is the zero-dependency heart both sides
  share: the versioned wire protocol, the `BridgeSession` state machine
  (transcript/signal/delegation queues, a durable append-only event log), the
  pluggable `Classifier` seam, and a sub-speaker segmenter that turns a
  monologue into readable segments.

Two front-door modes, chosen by configuration:

| Mode | What hears the room | Needs an API key |
|---|---|---|
| **direct-drain** (default) | your agent, via `WaitForTranscript` | no |
| **classifier** | a pluggable `Classifier` that filters/delegates, agent parks on `WaitForDelegation` | whatever your classifier needs |

## Quickstart

Register the gateway as an MCP server for Claude Code — in your project's
`.mcp.json`:

```json
{
  "mcpServers": {
    "convariance": {
      "command": "npx",
      "args": ["-y", "@convariance/gateway"]
    }
  }
}
```

Then ask Claude Code to call `GetSessionUrl` — it returns (and opens) a paired
web URL served from the gateway's own loopback origin. Feed transcript lines
from your page with the client SDK:

```ts
import { createBridgeClient } from '@convariance/client'

const client = createBridgeClient({ token, session })
client.on('turn', (turn) => render(turn))       // typed AI contributions
client.on('status', (s) => console.log(s))       // semantic session state
client.activate()
client.pushSegments(segments)                    // your STT's output
```

Or poke it with nothing but `curl`:

```sh
BRIDGE_EAGER=1 BRIDGE_TOKEN=dev npx -y @convariance/gateway &
curl -X POST http://127.0.0.1:7700/bridge/transcript \
  -H 'content-type: application/json' -H 'x-bridge-token: dev' \
  -d '{"speaker": "Ada", "text": "What could we ship by Friday?"}'
```

## Try it: the chat example

[`examples/chat`](examples/chat) is a tiny static SPA (no framework) for
live-chatting with Claude Code through the bridge — paste the launch URL
`GetSessionUrl` printed and type. It doubles as the reference for using
`@convariance/client`, and deploys to GitHub Pages:
**https://convariance.github.io/convariance/** (the gateway still runs on
your machine — see the example's [README](examples/chat/README.md) for the
one-line CORS config).

```sh
pnpm -F convariance-chat-example dev   # local dev on :5173
```

## Packages

| Package | What | Runs in |
|---|---|---|
| [`@convariance/core`](packages/core) | protocol, `BridgeSession`, `Classifier` seam, segmenter — zero deps | Node, workerd, browsers |
| [`@convariance/gateway`](packages/gateway) | the local gateway (stdio MCP + HTTP/SSE), `convariance-gateway` bin | Node ≥ 20 |
| [`@convariance/client`](packages/client) | the browser SDK (events out, segments in), launch-URL pairing | browsers |

## Protocol and stability

The wire protocol is versioned separately from the packages
(`PROTOCOL_VERSION`, currently **6**) and reported by `/bridge/health`. These
packages are **pre-1.0**: the API may move between minor versions, and a
protocol bump is a minor version with the wire impact called out in the
changelog. Protocol changes stay maintainer-driven until 1.0
([CONTRIBUTING](CONTRIBUTING.md)).

## Development

```sh
pnpm install
pnpm check     # typecheck + lint
pnpm test      # unit tests (node --test, runs straight from source)
pnpm smoke     # spawns a real gateway and exercises the whole protocol
pnpm build     # compile all packages to dist/
```

No build step is needed for development — Node runs the TypeScript source
directly (type stripping), and the workspace packages resolve to source.

## License

[Apache-2.0](LICENSE). convariance is the open-source engine behind
[Convariance Cloud](https://www.convariance.com), the hosted product.
