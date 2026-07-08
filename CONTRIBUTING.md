# Contributing

Thanks for your interest in convariance!

## Ground rules

- **DCO, not CLA.** Sign your commits off (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/).
- **Protocol changes are maintainer-driven until 1.0.** The wire protocol
  (`PROTOCOL_VERSION` in `src/core/protocol.ts`) is the compatibility currency
  between the gateway, the browser client, and hosted deployments — PRs that
  change wire shapes will be redirected to an issue first. Everything else is
  fair game.
- **Pre-1.0 posture.** APIs may move between minors; we keep the root
  `CHANGELOG.md` honest about it — describe user-visible changes there in
  your PR.

## Dev loop

```sh
pnpm install
pnpm check     # typecheck (whole repo, tests included) + lint
pnpm test      # unit tests — node --test, straight from source, no build
pnpm smoke     # integration: spawns real gateways, exercises the protocol
pnpm build     # tsdown → dist/, vite → dist/ui
pnpm gateway   # run the agent from source (serve mode)
pnpm dev       # web UI dev server on :5173 (pair against a live gateway)
```

Node ≥ 22 (the dev loop runs TypeScript via native type stripping — which is
also why the source sticks to erasable syntax only; the published package is
compiled JS + d.ts and runs on Node ≥ 20).

For UI work: run `BRIDGE_EAGER=1 pnpm gateway` in one terminal (binds the
HTTP face without waiting for an MCP client and prints a ready-to-open
launch URL) and either open that URL (serves the built `dist/ui` — run
`pnpm build` first) or run `pnpm dev` and paste the URL into :5173 — the
gateway's default origin allowlist already covers the Vite dev origin.

## Testing the npx flow before publishing

`npx convariance` resolves from the registry only when the package isn't
installed locally, so the pre-publish loop is:

```sh
# full flow from source, in any project (needs Node ≥ 22 on PATH):
pnpm build   # so the gateway has dist/ui to serve
claude mcp add convariance -- node /abs/path/to/convariance-oss/src/cli.ts
# → start Claude Code there and ask it to join your conversation

# or the published layout, exactly as npx will run it:
pnpm build && pnpm pack                    # → convariance-X.Y.Z.tgz
mkdir /tmp/try && cd /tmp/try && npm init -y
npm i /path/to/convariance-X.Y.Z.tgz
npx convariance                            # setup mode; npx resolves the
                                           # local install, no registry hit
```

The `.mcp.json` that setup writes (`npx -y convariance`) also resolves to the
local install, so the whole flow — setup, serve, packaged UI — behaves
exactly as it will after `pnpm publish`.

## Style

ESLint (`@stylistic`) is the only formatter — `pnpm format` to auto-fix.
Single quotes, no semicolons, no trailing commas, 2-space indent, `import
type` for type-only imports. Match the comment density of the file you're in:
comments state constraints the code can't, not narration.

## Tests

- Unit tests live next to their module (`*.test.ts`, `node --test`).
- The gateway smoke (`test/smoke.ts`) is the protocol
  regression net — it spawns real gateway processes in both modes (a stub
  classifier fixture and the shipped drain-mode bin) and needs no API key.
  If you touch session/gateway/protocol code, run it.
