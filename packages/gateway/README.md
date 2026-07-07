# @convariance/gateway

The local gateway of [convariance](https://github.com/convariance/convariance) —
one Node process that puts an MCP agent (Claude Code) in a live conversation.

Two faces, one in-memory session:

- **stdio MCP** — the agent side. Tools: `WaitForTranscript` (direct-drain) or
  `WaitForDelegation` (classifier mode), `SendSignal`, `SessionStatus`,
  `SyncTranscript`, `GetSessionUrl`. The agent parks in a blocking wait at
  zero token cost until there is work.
- **loopback HTTP** — the browser side: `POST /bridge/transcript`,
  `GET /bridge/signals` (SSE + poll fallback), `POST /bridge/end`,
  `GET /bridge/health`, plus optional same-origin serving of your built web
  UI. Lazy: no port is bound until the first `GetSessionUrl` (first free port
  from 7700 up).

## Standalone (direct-drain — no API key)

```json
{
  "mcpServers": {
    "convariance": { "command": "npx", "args": ["-y", "@convariance/gateway"] }
  }
}
```

Env: `BRIDGE_DIST` (serve a built UI directory), `BRIDGE_PORT`,
`BRIDGE_TOKEN`, `BRIDGE_HOST`, `BRIDGE_EAGER=1` (bind HTTP at launch, for
standalone runs), `BRIDGE_NO_OPEN=1` (never pop a browser),
`BRIDGE_ALLOWED_ORIGINS`, `BRIDGE_MAX_BLOCK_SEC`.

## Programmatic (bring your own classifier)

```ts
import { startGateway, createStaticHandler } from '@convariance/gateway'
import type { BridgeSession, Classifier } from '@convariance/core'

const myClassifier = (session: BridgeSession): Classifier | null => {
  // subscribe session.onTranscript, act via session.addSignal /
  // session.delegate / session.markClassified; return null when not ready
  ...
}

await startGateway({
  classifier: myClassifier,
  staticHandler: createStaticHandler('dist', { spaPrefixes: ['/app'] })
})
```

Apache-2.0.
