# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

convariance is the engine for an AI participant in a live conversation: a live
transcript streams in, an MCP agent (Claude Code) hears it, and typed inline
contributions flow back into the room while people are still talking. This
repo is one npm package — `convariance` — the open-source transport/sequencing
core that powers [Convariance Cloud](https://www.convariance.com), plus the
npx-runnable agent with a bundled web UI (mic via the Web Speech API, no
external services).

```
 mic / typing ──▶ web UI (dist/ui) ──▶ convariance agent ──▶ Claude Code
 Web Speech API    sentence forwarding    one Node process      parks on a
                   SSE drain, receipts    stdio MCP + HTTP      blocking wait
```

## Commands

```bash
pnpm build          # tsdown (dist/index|agent|cli) THEN vite build ui (dist/ui) — order matters
pnpm clean          # rimraf dist
pnpm check          # typecheck + lint
pnpm test           # node --test over src/**/*.test.ts (buildless, type-stripping)
pnpm smoke          # 23-step gateway protocol smoke test — keyless, buildless
pnpm typecheck      # tsc --noEmit (src + test + ui in one shot)
pnpm lint           # eslint .          (pnpm format = eslint --fix .)
pnpm gateway        # run the agent from source (explicit serve mode)
pnpm dev            # web UI dev server on :5173 (BRIDGE_EAGER=1 pnpm gateway alongside)
```

Always run these from the **repo root**.

## Architecture

One package (`convariance`, root package.json), three layers in `src/`:

| Layer | Path | Description |
|---|---|---|
| core | `src/core/` | Zero-dependency, isomorphic heart: the versioned wire protocol (`protocol.ts`), the `BridgeSession` transcript/signal/delegation state machine with a durable append-only event log (`session.ts`), the pluggable `Classifier` seam (`classifier.ts`), the sub-speaker segmenter (`segmenter.ts`). |
| client | `src/client/` | Dependency-free browser SDK: sentence forwarding with tail-idle backstop, SSE drain with poll fallback, idempotent delivery, mode-aware read receipts (`bridgeClient.ts`); pure launch-URL pairing helpers (`launchParams.ts`). |
| agent | `src/agent/` | The Node gateway: one process, two faces sharing one in-memory `BridgeSession` — a stdio MCP server and a loopback HTTP face (`/bridge/*` routes + static UI serving). Built on `@silkweave/{core,fastify,mcp}`. |

Entry points:

- `src/index.ts` → the **`convariance`** export: core + client, zero-dep,
  browser-safe (what convariance-cloud's frontend consumes).
- `src/agent.ts` → the **`convariance/agent`** export: `startGateway`,
  `createStaticHandler`, pairing runtime — Node-only (silkweave/zod deps).
- `src/cli.ts` → the **`convariance` bin**, dual-mode: TTY → setup (registers
  the MCP server via `claude mcp add`, falls back to `.mcp.json`); piped
  (MCP client) → serve (drain-mode gateway + the packaged UI from `dist/ui`,
  `BRIDGE_DIST` overrides). Explicit `serve`/`setup` subcommands exist.

`ui/` is the packaged web UI (framework-free Vite SPA): typed chat + Web
Speech API mic (`ui/src/speech.ts`), served same-origin by the gateway — the
launch URL auto-pairs via `window.location.origin`. It imports `convariance`
via a vite alias + tsconfig `paths` pinned to `src/index.ts` (never the
package self-reference — that would hit stale dist).

`test/` holds the protocol smoke (`smoke.ts`) and its fixtures: a stub
classifier, a not-ready factory (the hard-fail path), a static-UI fixture
(`fixtures/ui/`), and the shipped CLI spawned over pipes (which also proves
the dual-mode TTY detection). It must pass keyless and buildless.

## Deep-dive docs

CLAUDE.md is the index; the details live in `docs/`:

| Doc | Covers |
|---|---|
| [docs/protocol.md](docs/protocol.md) | the versioned wire protocol: v1→v6 history, drain vs classifier modes, the MCP tool surface, every `/bridge/*` route, auth/pairing (launch URL, token-in-fragment), cursors/idempotency, the turn lifecycle |
| [docs/architecture.md](docs/architecture.md) | the gateway process model (two faces, lazy HTTP boot, port walking, teardown), the dual-mode CLI, all `BRIDGE_*` env vars, the tmpdir pairing runtime, `BridgeSession` internals, the classifier seam, the client's forwarding discipline, dev tools |
| [docs/releasing.md](docs/releasing.md) | build mechanics (tsdown + vite ordering), the release flow (`pnpm version` + CHANGELOG.md + `pnpm publish --otp`), CI, the old-package deprecation, the cloud-consumer migration map |

## Gotchas

- **Build order**: the tsdown config has `clean: true` and wipes `dist/` —
  vite must run second (`pnpm build` enforces this; never run
  `vite build ui` alone after a clean).
- `pnpm-workspace.yaml` is a **config-only** file (no `packages:` — this is
  not a workspace): it pins `zod` to one version via `overrides` (the MCP SDK
  peers on zod 3; zod 3.25+ ships the v4 API at `zod/v4`), keeping a single
  `@silkweave/core` instance, and carries `allowBuilds`/release-age settings.
- In serve mode the CLI (and everything under `src/agent/`) must never write
  to stdout — it is reserved for MCP JSON-RPC; log via `makeLog` (stderr).
- The UI's `convariance` import resolves through the vite alias/tsconfig
  `paths` to `src/index.ts` — do not add `convariance` as a dependency of
  anything, and keep the alias when touching `ui/vite.config.ts`.
- The LICENSE is the verbatim Apache-2.0 text — never edit it.

## Code Style

- ESM-only (`"type": "module"`); consumers need Node >= 20, contributing
  (buildless type-stripping) needs Node >= 22
- No semicolons, single quotes, 2-space indent, no trailing commas
  (`@stylistic` rules in `eslint.config.mjs` enforce all of this)
- Unused vars must be prefixed with `_`
- `import type` for type-only imports (`consistent-type-imports` is an error)
- Tests co-locate as `*.test.ts` in `src/` (excluded from publish by the
  tsdown entry graph), written with `node:test` + `node:assert`

## Wrapup Config

- check: `pnpm check` — typecheck + lint, from the repo root
- test: `pnpm test` **and** `pnpm smoke` — both must pass, keyless
- push: yes
- version_bump: `pnpm version minor|patch` (plain semver, git tag `vX.Y.Z`)
- publish: `pnpm publish --otp=<code>` — `prepack` runs the full build;
  after the FIRST publish, npm-deprecate `@convariance/{core,client,gateway}`
  (see docs/releasing.md)
- docs: README.md + this CLAUDE.md as index + deep-dives in `docs/*.md`
  (protocol, architecture, releasing) — keep the relevant doc current when
  the protocol, gateway runtime, CLI, or release flow changes
- frontend_smoke: the packaged UI — `pnpm build`, then `pnpm gateway` and
  load the launch URL (or rely on the smoke's static-UI step for the wiring)
- changelog: yes — hand-maintained root CHANGELOG.md; describe every
  user-visible change, call out wire-protocol impact explicitly
- extra: this repo is consumed by the private Convariance Cloud repo
  (`tobiasstrebitzer/convariance-cloud`) — flag any breaking change to the
  wire protocol or package API so the cloud side can be updated in lockstep
  (import map: `@convariance/core`/`client` → `convariance`,
  `@convariance/gateway` → `convariance/agent`)
