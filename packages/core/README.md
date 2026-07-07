# @convariance/core

The zero-dependency, isomorphic heart of [convariance](https://github.com/convariance/convariance) —
put Claude Code (or any MCP agent) in your live conversation.

- **The wire protocol** (`PROTOCOL_VERSION`, currently v6): every shape that
  flows between the web app, the gateway, and the agent — signals, transcript
  lines, delegations, the durable event log, health/status.
- **`BridgeSession`**: the session state machine — transcript/signal buffers,
  the delegation queue (de-dup / supersede / one-at-a-time), blocking waiters,
  read-receipt cursors, and an append-only event log of speech + AI cards.
- **The `Classifier` seam**: plug a front-door classifier over the session
  (`onTranscript` → `addSignal` / `delegate` / `markClassified`) — or run
  without one (direct-drain mode).
- **The segmenter**: turns provider token streams into readable, sub-speaker
  transcript segments (pause / sentence-boundary / length backstops).

Runs in Node, workerd, and browsers. See the
[repo README](https://github.com/convariance/convariance#readme) for the full
picture; `@convariance/gateway` and `@convariance/client` build on this.

Apache-2.0.
