# Contributing

Thanks for your interest in convariance!

## Ground rules

- **DCO, not CLA.** Sign your commits off (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/).
- **Protocol changes are maintainer-driven until 1.0.** The wire protocol
  (`PROTOCOL_VERSION` in `@convariance/core`) is the compatibility currency
  between the gateway, the browser client, and hosted deployments — PRs that
  change wire shapes will be redirected to an issue first. Everything else is
  fair game.
- **Pre-1.0 posture.** APIs may move between minors; we keep the changelog
  honest about it (releases via [changesets](https://github.com/changesets/changesets) —
  add one with `pnpm changeset`).

## Dev loop

```sh
pnpm install
pnpm check     # typecheck (whole repo, tests included) + lint
pnpm test      # unit tests — node --test, straight from source, no build
pnpm smoke     # integration: spawns real gateways, exercises the protocol
pnpm build     # tsc project build to packages/*/dist
```

Node ≥ 22 (the dev loop runs TypeScript via native type stripping — which is
also why the source sticks to erasable syntax only; the published packages are
compiled JS + d.ts and run on Node ≥ 20).

## Style

ESLint (`@stylistic`) is the only formatter — `pnpm format` to auto-fix.
Single quotes, no semicolons, no trailing commas, 2-space indent, `import
type` for type-only imports. Match the comment density of the file you're in:
comments state constraints the code can't, not narration.

## Tests

- Unit tests live next to their module (`*.test.ts`, `node --test`).
- The gateway smoke (`packages/gateway/test/smoke.ts`) is the protocol
  regression net — it spawns real gateway processes in both modes (a stub
  classifier fixture and the shipped drain-mode bin) and needs no API key.
  If you touch session/gateway/protocol code, run it.
