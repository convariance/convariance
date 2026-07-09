# convariance

## 0.3.0

**Protocol v7 — comms** (Convariance Cloud PRD 019): ambient awareness for the
agent, a typed side channel for the room, and a steerable classifier. All
additive — a v6 browser client keeps working against a v7 gateway.

- **The digest**: every `wait_for_delegation` return (delegation, idle, or
  message) may carry `digest` — the durable-log events since the agent's last
  wake, the classifier's verdicts since then (including silent ones and an
  optional `agent_note` whisper), and the effective reflex params when they
  changed. The agent is no longer structurally mute when the classifier stays
  silent: it reviews the digest each heartbeat wake and MAY engage.
  `BridgeSession.recordVerdict()` is the classifier-agnostic feed; the digest
  is capped (`truncated` flags a larger gap — use `sync_transcript`).
- **The typed side channel**: `POST /bridge/message` queues a typed ask
  straight to the agent — it wakes a parked wait immediately (both
  `wait_for_delegation` and drain-mode `wait_for_transcript`) and rides the
  return as `messages`. Logged as a new `chat` event kind in the
  transcript-of-record; `BridgeSession.onChat()` is the persistence hook.
  Client: `sendMessage()` + the `chat` event.
- **Steerable classifier**: `ReflexParams` gains `directive` (a bounded
  steering paragraph appended to the classifier's prompt) and `sensitivity`
  (`quiet | balanced | eager`). A new agent tool **`ConfigureReflex`**
  patches them at runtime (deliberately no `model` field); the browser's
  `POST /bridge/config` accepts them too. Either principal's change bumps
  `params_rev` on status/health and ships the effective config in the
  agent's next digest — so UI edits reach the agent and agent edits reach
  the UI (client: `getConfig()`/`setConfig()` + the `config` event).

## 0.2.1

- **Card-complete forwarding** (`createBridgeClient`): a speech card now
  forwards only once it is COMPLETE — settled under a newer card, or idle past
  `tailIdleMs` — instead of sentence-by-sentence as it grew (with a partial
  naming the AI released even earlier). Eager forwarding fed the classifier
  unfinished thoughts: one spoken request could draw several interruptions
  ("All right. Claude." → an answer, before the actual ask landed). The agent
  now hears finished cards only. No wire-protocol change (still v6); the
  `params` cadence knobs are unchanged.

## 0.2.0

**One package.** The `@convariance/core`, `@convariance/client`, and
`@convariance/gateway` monorepo collapses into a single `convariance` package
(those three are deprecated on npm). No wire-protocol change — still
protocol v6.

- **`npx convariance` is the whole install**: run it in a terminal and it
  registers the MCP server with Claude Code (`claude mcp add`, falling back
  to writing `.mcp.json`); when Claude Code spawns it, it runs the agent.
  Explicit `convariance setup` / `convariance serve` subcommands override the
  detection. Replaces the `convariance-gateway` bin.
- **The web UI ships in the package** and is served by the gateway from its
  own loopback origin — the launch URL auto-pairs with zero setup. GitHub
  Pages hosting of the chat example is gone (`BRIDGE_DIST` still swaps in a
  custom bundle; `BRIDGE_ALLOWED_ORIGINS` still admits external hosts).
- **Mic transcription** in the bundled UI via the Web Speech API
  (Chrome/Edge) — speak or type, no external STT service, no API keys.
- **The bundled UI speaks the Convariance design system**: the cloud's color
  tokens (navy dark-first canvas, electric-blue accent, per-kind signal
  palette), self-hosted brand fonts (Fraunces display, Hanken Grotesk body,
  JetBrains Mono code — latin subsets, no CDN), the serif-C logomark as
  wordmark + favicon, and inlined lucide icons replacing the emoji badges.
  The agent's typed contributions now render as the same left-striped signal
  cards (Idea/Insight/Caution/Note) as Convariance Cloud, with `present`
  turns as the sparkles-avatar AI bubble and lucide tick delivery receipts.
  No wire-protocol change.
- **New import surface**: `convariance` (core + browser client, zero-dep,
  isomorphic) and `convariance/agent` (`startGateway`, static handler,
  pairing runtime — Node). Migration: `@convariance/core` and
  `@convariance/client` → `convariance`; `@convariance/gateway` →
  `convariance/agent`.
- Build moved to tsdown (+ vite for the UI); releases are plain
  `pnpm version` + this changelog (changesets removed).

## 0.1.1 and earlier

See the per-package CHANGELOGs in the repo history
(`packages/*/CHANGELOG.md` before the single-package restructure).
