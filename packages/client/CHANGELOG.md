# @convariance/client

## 0.1.1

### Patch Changes

- Republish: the 0.1.0 tarballs were published with `npm publish`, which does
  not apply `publishConfig.exports` (a pnpm feature) or rewrite `workspace:^`
  dependency ranges — consumers got packages whose entry points and internal
  deps could not resolve. 0.1.1 is the same code published correctly with pnpm;
  0.1.0 is deprecated. A `prepublishOnly` guard now refuses non-pnpm publishes.
- Updated dependencies
  - @convariance/core@0.1.1
