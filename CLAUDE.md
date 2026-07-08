# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

convariance is the engine for an AI participant in a live conversation: a live
transcript streams in, an MCP agent (Claude Code) hears it, and typed inline
contributions flow back into the room while people are still talking. This
repo is the open-source transport/sequencing core that powers
[Convariance Cloud](https://www.convariance.com).

```
 mic / STT ──▶ @convariance/client ──▶ @convariance/gateway ──▶ Claude Code
 (your app)      sentence forwarding      one Node process         parks on a
                 SSE drain, receipts       stdio MCP + HTTP        blocking wait
```

## Commands

```bash
pnpm build          # turbo run build — tsc -b per package, ordered by deps, cached
pnpm clean          # turbo run clean — rimraf dist + tsbuildinfo in every package
pnpm check          # typecheck + lint
pnpm test           # node --test over packages/*/src/**/*.test.ts (buildless, type-stripping)
pnpm smoke          # 22-step gateway protocol smoke test — keyless, no API key needed
pnpm typecheck      # tsc --noEmit on the root solution
pnpm lint           # eslint .          (pnpm format = eslint --fix .)
pnpm gateway        # run the gateway bin from source (direct-drain mode)
pnpm -F convariance-chat-example dev   # the chat example SPA on :5173
pnpm changeset      # record a changeset for the next release
pnpm release        # build + changeset publish
```

Always run these from the **repo root**.

## Architecture

Three packages, versioned in lockstep via changesets:

| Package | Path | Description |
|---------|------|-------------|
| `@convariance/core` | `packages/core` | Zero-dependency, isomorphic heart both sides share: the versioned wire protocol (`protocol.ts`), the `BridgeSession` transcript/signal/delegation state machine with a durable append-only event log (`session.ts`), the pluggable `Classifier` seam (`classifier.ts`), and the sub-speaker segmenter (`segmenter.ts`). |
| `@convariance/gateway` | `packages/gateway` | One Node process with two faces sharing one in-memory `BridgeSession`: a **stdio MCP server** the agent connects to (registered in `.mcp.json`) and a **loopback HTTP face** for the browser (`POST /bridge/transcript` in, `GET /bridge/signals` SSE out). Built on `@silkweave/{core,fastify,mcp}`. The shipped bin (`bin.ts` / `convariance-gateway`) runs **direct-drain mode** (no API key: the agent parks on `WaitForTranscript`); import `startGateway` to plug in a `Classifier` (agent parks on `WaitForDelegation`) or serve a static UI bundle. |
| `@convariance/client` | `packages/client` | Dependency-free browser SDK: push transcript segments in, it forwards each completed sentence (tail-idle backstop; AI-name partials forwarded immediately), drains signals over SSE with poll fallback, idempotent delivery, mode-aware read receipts, and surfaces typed events. `launchParams.ts` holds the pure launch-URL pairing helpers (parse/consume). |

The protocol smoke test (`packages/gateway/test/smoke.ts`) drives the full
gateway over real HTTP + MCP stdio with test fixtures: a stub classifier
(`stubClassifier.ts`), a not-ready factory (`entry-notready.ts`, the hard-fail
path), and the shipped drain-mode bin. It must pass keyless.

`examples/chat` (workspace package `convariance-chat-example`, private, never
published) is a framework-free Vite SPA for live-chatting with Claude Code —
the reference consumer of `@convariance/client`. It pairs by pasting the
launch URL (`parseLaunchParams` + the URL's origin as `endpoint`) and relies
on `BRIDGE_ALLOWED_ORIGINS` for cross-origin serving. Deployed to GitHub
Pages by `.github/workflows/pages.yml` (Pages must be set to the "GitHub
Actions" source in repo settings). It is deliberately named OUTSIDE the
`@convariance/*` scope so the changesets `fixed` group doesn't catch it.

## Package resolution (dev source vs. published build)

Each package's `exports` points at **TS source** (`./src/index.ts`) so tests
and the smoke run buildless via Node's type-stripping; `publishConfig.exports`
flips consumers to compiled `dist` (`types` + `default`). `pnpm pack` /
publish is where the flip happens — `workspace:^` deps rewrite to real semver
ranges at the same time.

Build mechanics worth knowing:

- Packages build with `tsc -b tsconfig.build.json` (composite project
  references: gateway and client reference core). Turbo orders builds via
  `dependsOn: ["^build"]` and caches `dist/**` + the tsbuildinfo.
- `clean` must remove `tsconfig.build.tsbuildinfo` along with `dist` —
  a stale tsbuildinfo makes `tsc -b` think it's up to date and skip re-emit.
- `prepack` runs `clean` + `build` in each package, so any pack/publish ships
  a fresh build.
- Source imports use `.ts` extensions; `rewriteRelativeImportExtensions`
  rewrites them to `.js` in `dist`.

## Gotchas

- **Publish with pnpm, NEVER `npm publish`**: `publishConfig.exports` (the
  src→dist flip) is a pnpm feature and npm doesn't rewrite `workspace:^`
  ranges in a pnpm workspace — the npm-published 0.1.0 tarballs were broken
  for every consumer (entry pointed at `./src/index.ts`, not in the tarball).
  A `prepublishOnly` guard in each package now hard-fails non-pnpm publishes.
- `pnpm-workspace.yaml` pins `zod` to one version via `overrides` (the MCP SDK
  peers on zod 3; zod 3.25+ ships the v4 API at `zod/v4`), keeping a single
  `@silkweave/core` instance in the graph.
- The LICENSE is the verbatim Apache-2.0 text — never edit it.

## Code Style

- ESM-only (`"type": "module"`), Node >= 20 (workspace tooling needs >= 22)
- No semicolons, single quotes, 2-space indent, no trailing commas
  (`@stylistic` rules in `eslint.config.mjs` enforce all of this)
- Unused vars must be prefixed with `_`
- `import type` for type-only imports (`consistent-type-imports` is an error)
- Tests co-locate as `*.test.ts` in `src/` (excluded from the build by
  `tsconfig.build.json`), written with `node:test` + `node:assert`

## Wrapup Config

- check: `pnpm check` — typecheck + lint, from the repo root
- test: `pnpm test` **and** `pnpm smoke` — both must pass, keyless
- push: yes
- version_bump: via changesets, lockstep across all three packages
  (`.changeset/config.json` has them in one `fixed` group)
- publish: `pnpm release` (build + `changeset publish`; access `public` is set
  in `.changeset/config.json`); npm auth required. `pnpm publish:all`
  (`pnpm publish -r --access public`) is the manual fallback that bypasses
  changesets — private packages (the example) are skipped automatically
- docs: root README.md + per-package README.md + this CLAUDE.md
- frontend_smoke: N/A
- changelog: yes — changesets generates per-package CHANGELOG.md entries on
  release; every user-visible change needs a changeset (`pnpm changeset`)
- extra: this repo is consumed by the private Convariance Cloud repo
  (`tobiasstrebitzer/convariance-cloud`) — flag any breaking change to the
  wire protocol or package APIs so the cloud side can be updated in lockstep
