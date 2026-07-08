# Building, releasing, publishing

## One package, one tarball

`convariance` publishes from the repo root. The tarball carries `dist/` only
(plus README/LICENSE): `dist/index.js|.d.ts` (main SDK), `dist/agent.js|.d.ts`
(gateway runtime), `dist/cli.js` (the `convariance` bin, shebang + exec bit),
and `dist/ui/` (the vite-built web UI the gateway serves). `exports` points at
`dist` unconditionally — there is no dev/publish exports flip and no
`workspace:^` rewriting anymore, so `npm publish` would technically work; we
still publish with pnpm for consistency.

## Build mechanics

- `pnpm build` = `tsdown && vite build ui`. **Order matters**: the tsdown
  config's `clean: true` wipes `dist/`, then vite fills `dist/ui`. tsdown
  builds two configs — the typed entries (`index`, `agent`, ESM + d.ts via
  rolldown) and the bin (`cli`, no d.ts). Runtime deps (silkweave, zod) stay
  external — declared in package.json, installed by the consumer.
- Dev needs no build: tests and the smoke run TS source via Node type
  stripping; the UI dev server (`pnpm dev`) and the root typecheck resolve
  `convariance` at `src/index.ts` (vite alias + tsconfig `paths`).
- `prepack` runs the full build, so any pack/publish ships fresh artifacts.
  CI additionally asserts the tarball contains the bin, both d.ts entries,
  and `dist/ui/index.html`.

## Release flow

Versioning is plain npm semver + a hand-maintained root `CHANGELOG.md` (no
changesets):

```sh
# 1. describe the release in CHANGELOG.md (wire impact called out explicitly)
pnpm version minor            # or patch — bumps package.json + git tag vX.Y.Z
git push --follow-tags
pnpm publish --otp=<code>     # prepack builds; npm requires 2FA
```

- Without `--otp`, npm may surface the OTP challenge as a misleading `E404`
  on the PUT.
- Freshly published versions can take a few minutes to become visible on GET
  while the PUT already knows the version exists — propagation, not failure.
- Publishes come from the maintainer account.

### One-time: deprecating the old scoped packages

The pre-0.2 monorepo published `@convariance/{core,client,gateway}`. After
the first `convariance` publish:

```sh
npm deprecate '@convariance/core@*'    "Merged into the 'convariance' package — import from 'convariance'"
npm deprecate '@convariance/client@*'  "Merged into the 'convariance' package — import from 'convariance'"
npm deprecate '@convariance/gateway@*' "Merged into the 'convariance' package — import from 'convariance/agent'"
```

## Protocol vs package versioning

The package is pre-1.0: the API may move between minors. The wire protocol
(`PROTOCOL_VERSION`, see [protocol.md](protocol.md)) is versioned separately;
a protocol bump is a minor package version with the wire impact called out in
the changelog. Protocol changes stay maintainer-driven until 1.0.

## CI

**`ci.yml`** — every push to `master` + PRs: install (frozen lockfile),
build, `pnpm check`, `pnpm test`, `pnpm smoke`, then the pack sanity step
(tarball must contain the bin, both d.ts entries, and the built UI).
Everything must pass keyless. There is no Pages deployment anymore — the web
UI ships inside the package and is served by the gateway itself.

## Downstream consumer

The private Convariance Cloud repo (`tobiasstrebitzer/convariance-cloud`)
consumes this package. Flag any breaking change to the wire protocol or the
package API so the cloud side can be updated in lockstep.

Migration map from the pre-0.2 scoped packages:

| Old | New |
|---|---|
| `import … from '@convariance/core'` | `import … from 'convariance'` |
| `import … from '@convariance/client'` | `import … from 'convariance'` |
| `import … from '@convariance/gateway'` | `import … from 'convariance/agent'` |
| deps `@convariance/{core,client,gateway}` | single dep `convariance` |
| bin `convariance-gateway` | `convariance` (`serve` is the default when spawned over pipes) |
