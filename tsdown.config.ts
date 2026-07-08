// Two configs, one dist/: the library entries (with d.ts) and the bin
// (shebang preserved, no d.ts). Order matters — the first config's
// `clean: true` wipes dist/, so `pnpm build` runs tsdown before
// `vite build ui` fills dist/ui. Runtime deps (silkweave, zod) stay
// external — declared in package.json, installed by the consumer.
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', agent: 'src/agent.ts' },
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: true
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: 'esm',
    platform: 'node',
    dts: false,
    clean: false
  }
])
