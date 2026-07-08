# Building, releasing, publishing

## Dev source vs. published build

Each package's `exports` points at **TS source** (`./src/index.ts`) so tests,
the smoke, and Vite consume source directly (Node type-stripping — no build
step in dev). `publishConfig.exports` flips consumers to compiled `dist`
(`types` + `default`). **The flip is a pnpm feature**: it happens at
`pnpm pack` / `pnpm publish`, at the same time `workspace:^` deps rewrite to
real semver ranges.

> **Publish with pnpm, NEVER `npm publish`.** npm applies neither
> `publishConfig.exports` nor the workspace rewrite in a pnpm workspace — the
> npm-published 0.1.0 tarballs shipped an entry point (`./src/index.ts`) that
> wasn't in the tarball and, in the gateway, a literal `workspace:^`
> dependency. All three 0.1.0s are deprecated for this. A `prepublishOnly`
> guard in each package now hard-fails any non-pnpm publish.

## Build mechanics

- Packages build with `tsc -b tsconfig.build.json` (composite project
  references: gateway/client reference core). Turbo orders via
  `dependsOn: ["^build"]` and caches `dist/**` + the tsbuildinfo.
- `clean` must remove `tsconfig.build.tsbuildinfo` along with `dist` — a stale
  tsbuildinfo makes `tsc -b` think it's up to date and skip re-emit.
- `prepack` = `clean` + `build` in each package, so any pack/publish ships a
  fresh build. Source imports use `.ts` extensions;
  `rewriteRelativeImportExtensions` rewrites them to `.js` in `dist`.
- The root typecheck (`tsc -p tsconfig.json --noEmit`) path-maps the package
  names to their source entries — one one-shot check, no build order.

## Release flow (changesets, lockstep)

All three packages version together (`.changeset/config.json`,
`fixed: [["@convariance/*"]]`; the chat example is deliberately named outside
the scope so it is never caught). Every user-visible change needs a changeset.

```sh
pnpm changeset            # record the change (per-package bump + summary)
pnpm changeset version    # consume changesets → bump versions + CHANGELOGs
git commit … && git push
pnpm release              # build + changeset publish   (or: pnpm publish:all)
```

- npm requires **2FA for publishes**: pass `--otp=<code>`
  (`pnpm publish:all --otp=123456`). Without it, pnpm surfaces the OTP
  challenge as a misleading `E404` on the PUT (npm masks unauthorized writes
  to scoped packages as 404).
- `pnpm publish -r` skips versions already on the registry — re-running is
  safe/idempotent.
- Tag each release changesets-style and push:
  `git tag "@convariance/core@X.Y.Z"` (one per package), `git push --tags`.
- Freshly published packages can take a few minutes to become visible on GET
  while the PUT already knows the version exists — propagation, not failure.
- The npm org is `convariance`; publishes come from the maintainer account.

## Protocol vs package versioning

Packages are pre-1.0: the API may move between minors. The wire protocol
(`PROTOCOL_VERSION`, see [protocol.md](protocol.md)) is versioned separately;
a protocol bump is a minor package version with the wire impact called out in
the changelog. Protocol changes stay maintainer-driven until 1.0.

## CI / Pages

- **`ci.yml`** — every push to `master` + PRs: install (frozen lockfile),
  build, `pnpm check`, `pnpm test`, `pnpm smoke`. Everything must pass
  keyless.
- **`pages.yml`** — builds the chat example with
  `BASE_PATH=/<repo>/` and deploys it to GitHub Pages
  (https://convariance.github.io/convariance/). Pages is configured with the
  "GitHub Actions" source; the `github-pages` environment's deployment branch
  policy must allow `master` (it was created allowing only the old default
  branch — update it via
  `gh api repos/…/environments/github-pages/deployment-branch-policies` if
  the default branch ever changes again).

## Downstream consumer

The private Convariance Cloud repo (`tobiasstrebitzer/convariance-cloud`)
consumes these packages. Flag any breaking change to the wire protocol or the
package APIs so the cloud side can be updated in lockstep.
