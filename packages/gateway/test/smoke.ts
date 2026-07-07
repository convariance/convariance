// Validates the gateway protocol WITHOUT Claude Code, so a protocol bug can't
// masquerade as an architecture failure in the live test. Spawns its own
// gateway on a spare port with a known token (classifier mode via the
// no-network stub classifier fixture, so it's reflex_ready — v5 requires it),
// then exercises: the MCP handshake + tool list, the idle + delivering
// wait_for_delegation round-trip, the GetSessionUrl launch helper, token auth
// (401), the signal round-trip over HTTP poll + SSE, the durable transcript
// sync, the v5 hard-fail (a not-ready classifier refuses the round), and
// direct-drain mode (no classifier → WaitForTranscript, keyless — the shipped
// bin's default).
//
//   node packages/gateway/test/smoke.ts   → PASS/FAIL per step, exit 0 iff all pass

import http from 'node:http'
import { spawn } from 'node:child_process'
import { PROTOCOL_VERSION } from '@convariance/core'

const PORT = 7791
const TOKEN = 'smoke-token'
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- smoke harness pokes loose JSON
type Json = Record<string, any>

// The main child runs classifier mode via the stub-classifier fixture: the
// gateway is reflex_ready (v5 requires it — else GetSessionUrl hard-fails)
// WITHOUT a key or any model calls, and a `DELEGATE: …` transcript line
// becomes a delegation so we can drive the wait_for_delegation round-trip.
const stubEntry = new URL('./entry-stub.ts', import.meta.url).pathname
const notReadyEntry = new URL('./entry-notready.ts', import.meta.url).pathname
const drainEntry = new URL('../src/bin.ts', import.meta.url).pathname
const child = spawn('node', [stubEntry], {
  // BRIDGE_NO_OPEN keeps GetSessionUrl from popping a real browser in CI/dev.
  env: {
    ...process.env,
    BRIDGE_PORT: String(PORT),
    BRIDGE_TOKEN: TOKEN,
    BRIDGE_NO_OPEN: '1'
  },
  stdio: ['pipe', 'pipe', 'inherit']
})

// --- JSON-RPC over the child's stdio ----------------------------------------
let buf = ''
const pending = new Map<number, (m: Json) => void>()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg: Json
    try {
      msg = JSON.parse(line) as Json
    } catch {
      continue // notifications/progress etc. — ignore non-response frames
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
    }
  }
})

let nextId = 1
const rpc = (method: string, params: Json): Promise<Json> =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const notify = (method: string, params: Json) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
const toolJson = (resp: Json): Json => JSON.parse(resp.result.content[0].text)

let failures = 0
const check = (label: string, ok: boolean, extra = '') => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}\n`)
  if (!ok) failures++
}

// Minimal SSE client: GET with Accept: text/event-stream, collect `data:` JSON
// frames for a short window, then close.
function sseCollect(path: string, ms: number): Promise<Json[]> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, headers: { Accept: 'text/event-stream' } },
      (res) => {
        let acc = ''
        const out: Json[] = []
        res.setEncoding('utf8')
        res.on('data', (d: string) => {
          acc += d
          for (const block of acc.split('\n\n')) {
            const m = block.match(/^data: (.+)$/m)
            if (m?.[1] && m[1] !== '{}') {
              try {
                out.push(JSON.parse(m[1]) as Json)
              } catch {
                /* partial */
              }
            }
          }
          acc = acc.slice(acc.lastIndexOf('\n\n') + 2)
        })
        setTimeout(() => {
          res.destroy()
          resolve(out)
        }, ms)
      }
    )
    req.on('error', () => resolve([]))
    req.end()
  })
}

async function main() {
  await sleep(600) // let the HTTP face bind

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' }
  })
  check(
    'initialize',
    init.result?.serverInfo?.name === 'convariance-bridge',
    `${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`
  )
  notify('notifications/initialized', {})

  const list = await rpc('tools/list', {})
  const names = (list.result?.tools || []).map((t: Json) => t.name)
  check(
    'tools/list has the agent tools',
    [
      'WaitForDelegation',
      'SendSignal',
      'SessionStatus',
      'SyncTranscript',
      'GetSessionUrl'
    ].every((n) => names.includes(n)),
    names.join(',')
  )

  const idle = toolJson(
    await rpc('tools/call', {
      name: 'WaitForDelegation',
      arguments: { max_wait_seconds: 1 }
    })
  )
  check('WaitForDelegation (idle timeout)', idle.idle === true)

  // GetSessionUrl builds the paired launch URL (token embedded, title carried).
  const launch = toolJson(
    await rpc('tools/call', {
      name: 'GetSessionUrl',
      arguments: { title: 'Q3 OKR' }
    })
  )
  check(
    'GetSessionUrl returns a paired URL',
    typeof launch.url === 'string' &&
      launch.url.includes(`token=${TOKEN}`) &&
      launch.url.includes('title=Q3') &&
      launch.opened === false,
    launch.url
  )

  // 401 without a token
  const unauth = await fetch(`${BASE}/bridge/signals?since=0`).then((r) => r.status)
  check('HTTP rejects missing token (401)', unauth === 401, `status ${unauth}`)

  // health is unauthenticated
  const health = (await fetch(`${BASE}/bridge/health`).then((r) => r.json())) as Json
  check(
    'health is open + reports protocol',
    health.ok === true && health.protocol_version === PROTOCOL_VERSION,
    `v${health.protocol_version}`
  )

  // v5: the reflex is mandatory; with the stub wired the gateway is reflex_ready
  // (a no-key gateway would have hard-failed GetSessionUrl above). The hard-fail
  // path itself is covered separately at the end (checkHardFail).
  check(
    'reflex ready (v5, stub wired)',
    health.reflex_ready === true,
    `reflex_ready=${health.reflex_ready}`
  )

  // v5 delegation round-trip: park on wait_for_delegation, then POST a transcript
  // line the stub turns into a delegation — the agent's heartbeat must deliver it.
  // (Raw speech never reaches the agent now; only delegations do.)
  const waitP = rpc('tools/call', {
    name: 'WaitForDelegation',
    arguments: { max_wait_seconds: 10 }
  })
  await sleep(150)
  await fetch(`${BASE}/bridge/transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
    body: JSON.stringify({ speaker: 'Alex', text: 'DELEGATE: find the Q3 market size' })
  })
  const wd = toolJson(await waitP)
  check(
    'WaitForDelegation delivers a delegation',
    wd.delegations?.length === 1 && wd.delegations[0]?.task?.includes('market size'),
    `id=${wd.delegations?.[0]?.id} task=${JSON.stringify(wd.delegations?.[0]?.task)}`
  )

  // SendSignal, then drain over the HTTP poll (buffered JSON array)
  const sig = toolJson(
    await rpc('tools/call', {
      name: 'SendSignal',
      arguments: {
        type: 'insight',
        text: 'Cap it at three objectives.',
        detail: 'They over-spread last quarter.',
        confidence: 0.7
      }
    })
  )
  check('SendSignal', sig.ok === true && sig.idx === 0)

  const drained = (await fetch(`${BASE}/bridge/signals?since=0&token=${TOKEN}`).then((r) =>
    r.json()
  )) as Json[]
  check(
    'signal visible over HTTP poll',
    Array.isArray(drained) && drained.length === 1 && drained[0]?.type === 'insight'
  )

  // SSE push: a fresh stream replays the backlog frame
  const frames = await sseCollect(`/bridge/signals?since=0&token=${TOKEN}`, 400)
  check('signal visible over SSE push', frames[0]?.type === 'insight', `${frames.length} frame(s)`)

  // address signal round-trip (PRD 004): carries the request text + ref/confidence
  const addr = toolJson(
    await rpc('tools/call', {
      name: 'SendSignal',
      arguments: {
        type: 'address',
        text: 'research the market size from what we discussed',
        confidence: 0.9,
        ref: [{ seg: 1 }]
      }
    })
  )
  check('SendSignal (address)', addr.ok === true && addr.idx === 1)

  const drained2 = (await fetch(`${BASE}/bridge/signals?since=1&token=${TOKEN}`).then((r) =>
    r.json()
  )) as Json[]
  check(
    'address signal drains with request intact',
    Array.isArray(drained2) &&
      drained2.length === 1 &&
      drained2[0]?.type === 'address' &&
      drained2[0]?.text.includes('market size')
  )

  // session_status counters
  const status = toolJson(await rpc('tools/call', { name: 'SessionStatus', arguments: {} }))
  check(
    'SessionStatus counters',
    status.transcript_lines === 1 && status.signals_sent === 2
  )

  // pending snippet round-trip (v3): a pending `present` opens a loading card,
  // a second `present` with the SAME id completes it — both fields must survive.
  const pend = toolJson(
    await rpc('tools/call', {
      name: 'SendSignal',
      arguments: { type: 'present', id: 'sn1', pending: true, text: 'Researching…' }
    })
  )
  const done = toolJson(
    await rpc('tools/call', {
      name: 'SendSignal',
      arguments: { type: 'present', id: 'sn1', text: 'The market is ~$4B.' }
    })
  )
  const drained3 = (await fetch(`${BASE}/bridge/signals?since=${pend.idx}&token=${TOKEN}`).then(
    (r) => r.json()
  )) as Json[]
  check(
    'pending snippet id/pending survive the round-trip',
    pend.ok === true &&
      done.ok === true &&
      drained3.length === 2 &&
      drained3[0]?.id === 'sn1' &&
      drained3[0]?.pending === true &&
      drained3[1]?.id === 'sn1' &&
      drained3[1]?.pending === undefined
  )

  // sync_transcript (v6): the durable, append-only transcript-of-record — every
  // speech line AND every completed AI card interleaved under one monotonic idx.
  // At this point the round holds 1 speech line + 3 non-pending cards (insight,
  // address, the filled present); the pending placeholder is NOT logged.
  const synced = toolJson(await rpc('tools/call', { name: 'SyncTranscript', arguments: { since: 0 } }))
  check(
    'SyncTranscript replays speech + cards under one idx',
    synced.total === 4 &&
      synced.events?.length === 4 &&
      synced.events[0]?.kind === 'speech' &&
      synced.events[0]?.text.includes('market size') &&
      synced.events.some((e: Json) => e.kind === 'card' && e.text.includes('$4B')),
    `total=${synced.total} cursor=${synced.cursor}`
  )

  const synced2 = toolJson(
    await rpc('tools/call', { name: 'SyncTranscript', arguments: { since: synced.cursor } })
  )
  check(
    'SyncTranscript is incremental (nothing after the cursor)',
    synced2.events?.length === 0 && synced2.total === 4 && synced2.cursor === synced.cursor,
    `returned=${synced2.events?.length}`
  )

  await checkHardFail()
  await checkDrainMode()
}

// A throwaway sibling gateway on its own port + the minimal stdio JSON-RPC
// plumbing to drive it (mirrors the module-level rig for the main child).
function spawnGateway(entry: string, port: number, env: Record<string, string>) {
  const proc = spawn('node', [entry], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_NO_OPEN: '1',
      ...env
    },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  let b = ''
  const pend = new Map<number, (m: Json) => void>()
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    b += chunk
    let nl: number
    while ((nl = b.indexOf('\n')) >= 0) {
      const line = b.slice(0, nl).trim()
      b = b.slice(nl + 1)
      if (!line) continue
      try {
        const m = JSON.parse(line) as Json
        if (m.id !== undefined && pend.has(m.id)) {
          pend.get(m.id)!(m)
          pend.delete(m.id)
        }
      } catch {
        /* non-response frame */
      }
    }
  })
  let id = 1
  const call = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve) => {
      const myId = id++
      pend.set(myId, resolve)
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`)
    })
  const init = async (name: string): Promise<void> => {
    await sleep(600)
    await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name, version: '0' }
    })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  }
  return { proc, call, init }
}

// v5 hard-fail: a classifier-mode gateway whose factory reports not-ready
// (returns null — e.g. no API key behind a real classifier) must refuse the
// round at GetSessionUrl rather than open a dead room.
async function checkHardFail(): Promise<void> {
  const gw = spawnGateway(notReadyEntry, PORT + 1, {
    BRIDGE_TOKEN: 'hardfail-token',
    BRIDGE_NO_ENV: '1'
  })
  try {
    await gw.init('smoke-hardfail')
    const res = await gw.call('tools/call', { name: 'GetSessionUrl', arguments: {} })
    const out = JSON.parse(res.result.content[0].text) as Json
    check(
      'GetSessionUrl hard-fails on a not-ready classifier (v5)',
      typeof out.error === 'string' && out.url === undefined,
      out.error ? 'refused' : `url=${out.url}`
    )
  } finally {
    gw.proc.kill()
  }
}

// Direct-drain mode: a gateway with NO classifier configured must run keyless —
// WaitForTranscript replaces WaitForDelegation in the tool set, GetSessionUrl
// does not gate on reflex_ready, health stamps mode:'drain', and a pushed
// transcript line drains straight to the agent. Runs the SHIPPED bin, which is
// drain mode by definition.
async function checkDrainMode(): Promise<void> {
  const port = PORT + 2
  const token = 'drain-token'
  const gw = spawnGateway(drainEntry, port, {
    BRIDGE_TOKEN: token,
    BRIDGE_NO_ENV: '1'
  })
  try {
    await gw.init('smoke-drain')

    const list = await gw.call('tools/list', {})
    const names = (list.result?.tools || []).map((t: Json) => t.name)
    check(
      'drain mode swaps WaitForDelegation for WaitForTranscript',
      names.includes('WaitForTranscript') && !names.includes('WaitForDelegation'),
      names.join(',')
    )

    const launch = JSON.parse(
      (await gw.call('tools/call', { name: 'GetSessionUrl', arguments: {} }))
        .result.content[0].text
    ) as Json
    check(
      'drain mode opens the round without a key',
      typeof launch.url === 'string' && launch.error === undefined,
      launch.url ?? launch.error
    )

    const health = await new Promise<Json>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/bridge/health`, (res) => {
        let acc = ''
        res.setEncoding('utf8')
        res.on('data', (d: string) => (acc += d))
        res.on('end', () => resolve(JSON.parse(acc) as Json))
      }).on('error', reject)
    })
    check('drain mode health stamps mode', health.mode === 'drain', `mode=${health.mode}`)

    // Push a line over HTTP, then drain it via WaitForTranscript.
    const wait = gw.call('tools/call', {
      name: 'WaitForTranscript',
      arguments: { max_wait_seconds: 5 }
    })
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/bridge/transcript',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bridge-token': token }
        },
        (res) => {
          res.resume()
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ speaker: 'Ada', text: 'What is the Q3 market size?' }))
    })
    const drained = JSON.parse((await wait).result.content[0].text) as Json
    check(
      'drain mode delivers speech via WaitForTranscript',
      drained.lines?.length === 1 &&
        drained.lines[0]?.speaker === 'Ada' &&
        drained.idle === false,
      `lines=${drained.lines?.length} cursor=${drained.cursor}`
    )
  } finally {
    gw.proc.kill()
  }
}

main()
  .catch((e) => {
    process.stderr.write(`smoke error: ${String(e)}\n`)
    failures++
  })
  .finally(() => {
    child.kill()
    process.stdout.write(
      failures === 0
        ? '\nALL PASS — gateway protocol is sound.\n'
        : `\n${failures} FAILURE(S).\n`
    )
    process.exit(failures === 0 ? 0 : 1)
  })
