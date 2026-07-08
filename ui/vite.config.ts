import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The packaged web UI. `convariance` resolves to SOURCE (not the package
// self-reference → stale dist) so dev and build always compile fresh src/;
// tsconfig `paths` mirrors this for the typechecker. Built straight into
// dist/ui, where the gateway's static handler (cli.ts resolveUiDir) finds it.
export default defineConfig({
  base: '/',
  resolve: {
    alias: {
      convariance: fileURLToPath(new URL('../src/index.ts', import.meta.url))
    }
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true
  }
})
