// Zero-dep static serving for the built bundle. The gateway serves the web app
// from its OWN loopback origin (PRD 007 §6.1 transport decision) so the browser
// and the bridge share one origin — no mixed-content, no Local Network Access
// prompt, and `bridgeUrl` is implicit. This handler covers everything that is
// NOT a /bridge/* API route (see gateway.ts serverFactory); the API is Fastify.
//
// Generic (PRD 018): what the dist/ contains and which routes boot the SPA
// shell are the CALLER's concern, passed as options. A dual-surface dist/
// works too — e.g. static marketing pages (index.html, how-it-works.html,
// 404.html) alongside a product SPA shell (app.html + /assets), with
// `spaPrefixes` naming which prefixes boot the shell — so a launch URL
// (/app/session?…#token=…) boots the SPA with its query/fragment untouched.
// Anything else is a file, or the 404 page when the bundle has one.

import type http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
}

export interface StaticHandler {
  /** True if the dist/ bundle exists; when false the gateway warns to build. */
  readonly available: boolean
  serve(req: http.IncomingMessage, res: http.ServerResponse): void
}

export interface StaticHandlerOptions {
  /** Route prefixes that boot the SPA shell instead of resolving as files
   *  (path/query/fragment untouched). Default: none. */
  spaPrefixes?: string[]
  /** The SPA shell filename inside `dir` (e.g. `app.html` when the bundle's
   *  index.html is a separate marketing page). Falls back to index.html when
   *  the named file is missing. Default: index.html. */
  spaShell?: string
  /** The 503 body when the bundle is missing (point the operator at the right
   *  build command). */
  missingMessage?: string
}

/** Build a static handler rooted at `dir` (the assembled `dist/`). */
export function createStaticHandler(
  dir: string,
  opts: StaticHandlerOptions = {}
): StaticHandler {
  const root = path.resolve(dir)
  const spaPrefixes = opts.spaPrefixes ?? []
  const missingMessage = opts.missingMessage ?? 'UI bundle not built.'
  const isSpaRoute = (pathname: string): boolean =>
    spaPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  const indexPath = path.join(root, 'index.html')
  // The SPA shell: the named file when present, else index.html (a bundle
  // where index.html IS the shell keeps working).
  const namedShell = opts.spaShell ? path.join(root, opts.spaShell) : null
  const shellPath = namedShell && fs.existsSync(namedShell) ? namedShell : indexPath
  const notFoundPath = path.join(root, '404.html')
  const available = fs.existsSync(shellPath)

  const sendFile = (res: http.ServerResponse, file: string, code = 200): void => {
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
    // Hashed assets are immutable; HTML must always re-validate.
    const immutable =
      file.includes(`${path.sep}assets${path.sep}`) ||
      file.includes(`${path.sep}_astro${path.sep}`)
    res.writeHead(code, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    })
    fs.createReadStream(file).pipe(res)
  }

  return {
    available,
    serve(req, res) {
      if (!available) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(missingMessage)
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      // Resolve within root and refuse traversal outside it.
      const target = path.resolve(root, rel)
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (rel && fs.existsSync(target) && fs.statSync(target).isFile()) {
        sendFile(res, target)
        return
      }
      // Clean URLs: /how-it-works → how-it-works.html (static-site builds
      // that emit one .html file per page).
      const htmlTarget = `${target}.html`
      if (rel && fs.existsSync(htmlTarget) && fs.statSync(htmlTarget).isFile()) {
        sendFile(res, htmlTarget)
        return
      }
      // SPA routes boot the shell (path/query/fragment untouched).
      if (isSpaRoute(url.pathname)) {
        sendFile(res, shellPath)
        return
      }
      if (!rel) {
        sendFile(res, indexPath)
        return
      }
      // Unknown path: the bundle's 404 page when it has one, else the shell
      // (plain SPA-fallback behavior).
      if (fs.existsSync(notFoundPath)) {
        sendFile(res, notFoundPath, 404)
        return
      }
      sendFile(res, shellPath)
    }
  }
}
