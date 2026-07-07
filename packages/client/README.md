# @convariance/client

The browser SDK of [convariance](https://github.com/convariance/convariance) —
feed live transcript segments in, get a typed AI participant out. Zero
dependencies; your app owns rendering, persistence, and sound.

```ts
import { createBridgeClient, consumeLaunchParams } from '@convariance/client'

const { token, session } = consumeLaunchParams()  // one-tap pairing URL

const client = createBridgeClient({ token, session, trigger: 'Claude' })
client.on('turn', (t) => render(t))          // open / update / fill-in-place
client.on('status', (s) => showStatus(s))    // semantic session state
client.on('presence', (p) => chips(p))       // classifier/agent liveness
client.on('delivery', (d) => ticks(d))       // per-segment read receipts

client.activate()                            // connect + drain
client.pushSegments(segments)                // your STT's segments
client.setForwarding(false)                  // pause (soft)
client.dispose()                             // leave (hard end)
```

What it does for you:

- **Sentence-level forwarding**: each completed sentence is forwarded the
  moment it closes; a trailing incomplete sentence waits a short idle
  backstop — unless it names the AI (`trigger`), which flushes immediately.
- **Robust drain**: SSE with a poll fallback, an idempotent seen-set (backlog
  and reconnect re-delivery dedup), live-edge priming from `/bridge/health`.
- **Mode-aware receipts**: `delivered` vs `classified` cursors, matching the
  gateway's drain/classifier mode.
- **Pairing**: `parseLaunchParams` / `consumeLaunchParams` read the
  token-in-fragment launch URL (the token never reaches a server).

Apache-2.0.
