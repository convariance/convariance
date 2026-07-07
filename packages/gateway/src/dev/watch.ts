// Dev tool — the other end of the gateway: renders the signals the agent sends
// back, the way a web session's AI rail would. Drains the SSE push
// endpoint, pairing automatically via the gateway's token file (runtime.ts).
//
//   node packages/gateway/src/dev/watch.ts
//   BRIDGE_WATCH_POLL=1 node packages/gateway/src/dev/watch.ts   # use HTTP polling instead

import type { Signal } from '@convariance/core'
import { readInfo, latestInfo } from '../runtime.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Pair to the running gateway: an explicit BRIDGE_PORT pins it, otherwise pick
// the most recently started one (the HTTP face lands on a dynamic port now).
const explicit = Number(process.env.BRIDGE_PORT) || 0
const info = explicit ? readInfo(explicit) : latestInfo()
if (!info) {
  process.stderr.write(
    `no running gateway found${explicit ? ` for port ${explicit}` : ''} — start it first.\n`
  )
  process.exit(1)
}
const base = `http://127.0.0.1:${info.port}`

const ICON: Record<string, string> = {
  raise_hand: '✋',
  address: '🙋',
  candidate: '💡',
  insight: '🔎',
  caution: '⚠️',
  present: '🗣️',
  graph: '🕸️',
  note: '·'
}

function render(s: Signal): void {
  const ts = new Date(s.t).toLocaleTimeString()
  const icon = ICON[s.type] || '·'
  const conf = s.confidence == null ? '' : ` (${Math.round(s.confidence * 100)}%)`
  const detail = s.detail ? `\n      ↳ ${s.detail}` : ''
  process.stdout.write(`[${ts}] ${icon} ${s.type.toUpperCase()}${conf}: ${s.text}${detail}\n`)
}

const url = (since: number) => `${base}/bridge/signals?since=${since}&token=${info!.token}`

async function poll(): Promise<void> {
  process.stdout.write(`polling ${base}/bridge/signals — Ctrl-C to stop\n`)
  let since = 0
  for (;;) {
    try {
      const signals = (await fetch(url(since)).then((r) => r.json())) as Signal[]
      for (const s of signals) render(s)
      if (signals.length) since = signals[signals.length - 1]!.idx + 1
    } catch {
      // gateway not up yet
    }
    await sleep(1000)
  }
}

// SSE drain: a single long-lived request that streams signals as they arrive.
async function watchSse(): Promise<void> {
  process.stdout.write(`watching ${base}/bridge/signals (SSE) — Ctrl-C to stop\n`)
  try {
    const res = await fetch(url(0), { headers: { Accept: 'text/event-stream' } })
    if (!res.body) throw new Error('no stream body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      let nn: number
      while ((nn = acc.indexOf('\n\n')) >= 0) {
        const block = acc.slice(0, nn)
        acc = acc.slice(nn + 2)
        const m = block.match(/^data: (.+)$/m)
        if (m?.[1] && m[1] !== '{}') {
          try {
            render(JSON.parse(m[1]) as Signal)
          } catch {
            // ignore non-JSON frames
          }
        }
      }
    }
    process.stderr.write('stream closed — gateway gone or session ended.\n')
  } catch (e) {
    process.stderr.write(`sse error: ${(e as Error).message} — falling back to polling\n`)
    await poll()
  }
}

if (process.env.BRIDGE_WATCH_POLL) await poll()
else await watchSse()
