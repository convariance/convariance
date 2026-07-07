// The bridge gateway (PRD 007), built on silkweave. One process, one in-memory
// BridgeSession, two silkweave instances sharing it:
//   • stdio MCP      ← Claude Code connects here (launched via .mcp.json).
//                      Serves the agent tools (WaitForDelegation — or
//                      WaitForTranscript in drain mode / SendSignal /
//                      SessionStatus / SyncTranscript / GetSessionUrl).
//   • Fastify HTTP   ← the web app: POST /bridge/transcript, GET /bridge/signals
//                      (SSE drain), POST /bridge/end, GET /bridge/health. The
//                      same server also serves the caller's built UI from this
//                      loopback origin (staticHandler) so browser + bridge
//                      share one origin.
//
// Generic since PRD 018: the classifier and the static UI are OPTIONS wired by
// an entry file (convariance's is gateway-entry.ts), so the gateway core knows
// nothing about the reflex or the dist/ layout. No classifier = drain mode:
// the agent hears the room itself via WaitForTranscript.
//
// stdout is reserved for the stdio JSON-RPC channel — every log goes to stderr
// (log.ts), and Fastify's own logger is disabled. The token-efficiency bet still
// lives in the blocking waits (session.ts): the agent parks in its wait tool
// call at zero token cost until there is work.
//
// The HTTP face is LAZY: it does not bind a port at startup. A user may install
// this MCP at the user level and run several Claude Code sessions at once — each
// spawns its own gateway, so an eager server would have them all fight over port
// 7700. Instead the stdio (agent) face starts immediately (it is how Claude Code
// reaches us and what keeps the process alive), and the HTTP face is booted on
// the first GetSessionUrl — i.e. when a session actually starts — onto the
// first free port from 7700 up. Idle sessions never claim a port, and the face is
// torn down when Claude Code exits (it closes our stdin) so the port is released.
//
// Runs under Node's type stripping via an entry file (`pnpm gateway`). The agent
// and the HTTP face MUST be the same process so they share one session — which
// is exactly what .mcp.json launching the entry gives us.

import http from 'node:http'
import { silkweave } from '@silkweave/core'
import { stdio } from '@silkweave/mcp'
import { fastify } from '@silkweave/fastify'
import { BridgeSession } from '@convariance/core'
import type { ClassifierFactory } from '@convariance/core'
import { agentActionsFor, browserActions, CTX_KEYS, type ReflexConfig } from './actions.ts'
import type { StaticHandler } from './static.ts'
import { makeOpener } from './launch.ts'
import { makeLog } from './log.ts'
import { mintToken, writeInfo, clearInfo, loadBridgeEnv } from './runtime.ts'
import {
  BRIDGE_DEFAULT_PORT,
  PROTOCOL_VERSION,
  type BridgeMode
} from '@convariance/core'

export interface GatewayOptions {
  /** The pluggable front-door classifier (the v5 sole-classifier loop). Called
   *  once with the session; return null when it cannot run (e.g. no API key) —
   *  the round then hard-fails at GetSessionUrl rather than open a room whose
   *  AI can never react. OMIT entirely for direct-drain mode: the agent tools
   *  swap WaitForDelegation for WaitForTranscript and the agent hears the room
   *  itself (PRD 018). */
  classifier?: ClassifierFactory
  /** Serves everything that is NOT a /bridge/* route from the gateway's own
   *  loopback origin (the same-origin transport decision — PRD 007 §6.1).
   *  Omit → non-bridge paths get a plain 404. */
  staticHandler?: StaticHandler
  /** The web-app route GetSessionUrl builds the paired launch URL onto — the
   *  page that reads `?session`/`?title` + `#token`. Default: '/app/session'
   *  (match it to your staticHandler's SPA layout). */
  sessionPath?: string
}

/** Boot the gateway: the stdio agent face starts immediately; the HTTP face is
 *  lazy (first GetSessionUrl). Resolves once the agent face is up; the process
 *  then lives until stdin closes (MCP mode) or SIGINT/SIGTERM. */
export async function startGateway(opts: GatewayOptions = {}): Promise<void> {
  const log = makeLog('bridge')
  loadBridgeEnv()

  // First port to try; the HTTP face walks upward from here until one is free.
  const startPort = Number(process.env.BRIDGE_PORT) || BRIDGE_DEFAULT_PORT
  const host = process.env.BRIDGE_HOST || '127.0.0.1'
  const token = process.env.BRIDGE_TOKEN || mintToken()
  const maxBlockSec = Number(process.env.BRIDGE_MAX_BLOCK_SEC) || 50
  // How far to walk before giving up — enough room for many sibling sessions.
  const MAX_PORT_TRIES = 64

  const staticHandler = opts.staticHandler ?? null
  const openBrowser = makeOpener(log)

  const session = new BridgeSession({ maxBlockSec })

  // Which front door this gateway runs (PRD 018). With a classifier configured
  // it is the sole classifier (v5) and therefore MANDATORY: a factory that
  // returns null (no key) leaves reflex_ready false → GetSessionUrl hard-fails
  // the round. With none, drain mode: the agent drains speech itself.
  const mode: BridgeMode = opts.classifier ? 'classifier' : 'drain'
  const classifier = opts.classifier ? opts.classifier(session) : null
  session.setReflexReady(classifier != null)

  // Exposes the live classifier params to GET/POST /bridge/config (the Debug
  // Panel). Null-safe: with no classifier wired the config endpoints report
  // `params: null`.
  const reflexConfig: ReflexConfig = {
    get: () => classifier?.getParams() ?? null,
    set: (partial) => classifier?.setParams(partial) ?? null
  }

  // Same-origin (the gateway-served UI) plus the Vite dev origins, for the port
  // we actually bound. Browser callers send an Origin; same-origin GETs may omit
  // it (allowed). Non-browser callers (Claude Code, curl, the dev feeder) send
  // none and pass on the token. An explicit BRIDGE_ALLOWED_ORIGINS wins verbatim.
  function allowedOriginsFor(port: number): string[] {
    const list =
      process.env.BRIDGE_ALLOWED_ORIGINS ||
      [
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        'http://localhost:5173',
        'http://127.0.0.1:5173'
      ].join(',')
    return list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  function isAddrInUse(e: unknown): boolean {
    if ((e as { code?: string })?.code === 'EADDRINUSE') return true
    return /EADDRINUSE|address already in use/i.test((e as Error)?.message || '')
  }

  // --- the browser face (Fastify REST + SSE, + the static UI) ----------------
  // Built per-port so we can rebuild on a port clash. The serverFactory escape
  // hatch lets us own the http.Server (captured in `holder` so we can close it on
  // shutdown): /bridge/* is Fastify (token + Origin enforced here, so EventSource
  // can pass the token in the query string); everything else is the static UI on
  // the same origin.
  function buildBrowserFace(port: number) {
    const baseUrl = `http://${host}:${port}`
    const allowedOrigins = allowedOriginsFor(port)
    const holder: { server: http.Server | null } = { server: null }

    const tokenOf = (req: http.IncomingMessage): string | null => {
      const header = req.headers['x-bridge-token']
      if (typeof header === 'string') return header
      return new URL(req.url || '/', baseUrl).searchParams.get('token')
    }

    const browser = browserActions.reduce(
      (b, a) => b.action(a),
      silkweave({
        name: 'convariance-bridge-web',
        description: 'The convariance web session HTTP/SSE face.',
        version: String(PROTOCOL_VERSION)
      })
        .set(CTX_KEYS.SESSION, session)
        .set(CTX_KEYS.CONFIG, reflexConfig)
        .set(CTX_KEYS.MODE, mode)
        .adapter(
          fastify({
            host,
            port,
            logger: false,
            cors: { origin: allowedOrigins },
            serverFactory: (fastifyHandler) => {
              const server = http.createServer((req, res) => {
                const url = req.url || '/'
                const pathname = url.split('?')[0] ?? '/'

                if (pathname === '/bridge/health') return fastifyHandler(req, res)

                if (pathname.startsWith('/bridge/')) {
                  if (req.method === 'OPTIONS') return fastifyHandler(req, res)
                  const origin = req.headers.origin
                  if (origin && !allowedOrigins.includes(origin)) {
                    res.writeHead(403, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ error: 'origin not allowed' }))
                    return
                  }
                  if (tokenOf(req) !== token) {
                    res.writeHead(401, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({ error: 'missing or invalid pairing token' }))
                    return
                  }
                  return fastifyHandler(req, res)
                }

                if (staticHandler) {
                  staticHandler.serve(req, res)
                  return
                }
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
                res.end('no UI configured on this gateway')
              })
              holder.server = server
              return server
            }
          })
        )
    )

    return { browser, baseUrl, holder }
  }

  // The live HTTP face once booted, and the in-flight boot promise that dedups
  // concurrent GetSessionUrl calls.
  let active: { server: http.Server; port: number; baseUrl: string } | null = null
  let booting: Promise<{ baseUrl: string; port: number }> | null = null

  // Walk from `startPort` upward, binding the first free port. A clash (another
  // sibling gateway already on that port) just bumps to the next one.
  async function bootBrowserFace(): Promise<{ baseUrl: string; port: number }> {
    let lastErr: unknown
    for (let port = startPort; port < startPort + MAX_PORT_TRIES; port++) {
      const face = buildBrowserFace(port)
      try {
        await face.browser.start()
        active = { server: face.holder.server!, port, baseUrl: face.baseUrl }
        const infoPath = writeInfo({
          token,
          port,
          pid: process.pid,
          protocolVersion: PROTOCOL_VERSION,
          startedAt: Date.now()
        })
        log(`http+ws on ${face.baseUrl}`)
        log(`pairing token: ${token}`)
        log(`token file: ${infoPath}`)
        if (staticHandler && !staticHandler.available) {
          log('UI bundle missing — build it to serve the web app from here.')
        }
        return { baseUrl: face.baseUrl, port }
      } catch (e) {
        lastErr = e
        // Discard the half-built server before trying the next port.
        try {
          face.holder.server?.close()
        } catch {
          // not listening — nothing to close
        }
        if (isAddrInUse(e)) {
          log(`port ${port} busy — trying ${port + 1}`)
          continue
        }
        throw e
      }
    }
    throw new Error(
      `no free port in ${startPort}..${startPort + MAX_PORT_TRIES - 1}: ${String(lastErr)}`
    )
  }

  // Idempotent: the first call boots the face, later calls reuse it. Handed to
  // GetSessionUrl via context so booting the server is what starting a session
  // does — nothing binds a port until then.
  function ensureHttpFace(): Promise<{ baseUrl: string; port: number }> {
    if (active) return Promise.resolve({ baseUrl: active.baseUrl, port: active.port })
    if (!booting) {
      booting = bootBrowserFace().catch((e) => {
        booting = null // allow a later GetSessionUrl to retry
        throw e
      })
    }
    return booting
  }

  // --- the agent face (MCP over stdio) ----------------------------------------
  // Always start: it is how Claude Code reaches us, and stdin keeps us alive. The
  // HTTP face stays dormant until GetSessionUrl calls ensureHttpFace.
  const agent = agentActionsFor(mode).reduce(
    (b, a) => b.action(a),
    silkweave({
      name: 'convariance-bridge',
      description: 'The convariance live-session participant bridge.',
      version: String(PROTOCOL_VERSION)
    })
      .set(CTX_KEYS.SESSION, session)
      .set(CTX_KEYS.ENSURE, ensureHttpFace)
      .set(CTX_KEYS.TOKEN, token)
      .set(CTX_KEYS.OPEN, openBrowser)
      .set(CTX_KEYS.MODE, mode)
      .set(CTX_KEYS.SESSION_PATH, opts.sessionPath ?? '/app/session')
      .adapter(stdio())
  )
  await agent.start()

  log(`convariance bridge up — protocol v${PROTOCOL_VERSION}, ${mode} mode`)
  // BRIDGE_EAGER boots the HTTP face now instead of waiting for GetSessionUrl —
  // for standalone runs (`pnpm gateway &` + curl, or the dev feed/watch tools)
  // where no MCP client will ever call it. The smoke test and the real Claude
  // Code loop both go through GetSessionUrl, so they leave this off.
  if (process.env.BRIDGE_EAGER === '1') {
    ensureHttpFace().catch((e) => log('eager http boot failed:', (e as Error)?.message))
  } else {
    log('agent face on stdio; http face boots on first GetSessionUrl')
  }

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    if (active) {
      try {
        active.server.close()
      } catch {
        // already down
      }
      clearInfo(active.port)
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // Claude Code (or any MCP client) closes our stdin when the session exits — that
  // is our cue to tear down the HTTP face and free its port. Without this an
  // orphaned gateway would keep the port until the OS reaped it. Only in
  // MCP-driven mode: a standalone eager run has no client holding stdin open (it
  // may be /dev/null), so an immediate EOF must NOT be read as "session over" —
  // that lifecycle is the operator's (SIGINT/SIGTERM).
  if (process.env.BRIDGE_EAGER !== '1') {
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
  }
  // Backstop: drop the token file on any exit path (synchronous).
  process.on('exit', () => {
    if (active) clearInfo(active.port)
  })
}
