// Unit tests for the app-agnostic bridge client (PRD 018): the sentence-level
// forwarder, the signal → turn lifecycle (pending open / fill-in-place), and
// the mode-aware read receipts — against a mocked fetch + EventSource, real
// timers. These guard the event-emitter refactor (the client used to write the
// session store directly; now everything flows out as events).

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Signal } from '../core/index.ts'
import {
  createBridgeClient,
  type BridgeClient,
  type BridgeTurnEvent,
  type BridgeDeliveryEvent
} from './bridgeClient.ts'

const BASE = 'http://127.0.0.1:7999'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- mock gateway ------------------------------------------------------------
// A fetch stub that mimics the gateway's /bridge/* faces: the transcript ack
// (added/total, control lines consuming seg numbers like the real one) and a
// configurable health payload.

interface PostedLine {
  speaker: string
  text: string
  kind?: string
}

let postedLines: PostedLine[] = []
let historyLines: PostedLine[] = []
let serverTotal = 0
let health: Record<string, unknown> = {}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function installFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname
    if (path === '/bridge/transcript') {
      const body = JSON.parse(String(init?.body)) as
        | { lines?: PostedLine[] }
        | PostedLine
      const lines = 'lines' in body && body.lines ? body.lines : [body as PostedLine]
      postedLines.push(...lines)
      serverTotal += lines.length
      return jsonResponse({ ok: true, added: lines.length, total: serverTotal })
    }
    if (path === '/bridge/history') {
      const body = JSON.parse(String(init?.body)) as { lines: PostedLine[] }
      historyLines.push(...body.lines)
      return jsonResponse({ ok: true, stored: body.lines.length })
    }
    if (path === '/bridge/health') return jsonResponse(health)
    if (path === '/bridge/signals') return jsonResponse([])
    // /bridge/session, /bridge/end
    return jsonResponse({ ok: true })
  }) as typeof fetch
}

// A minimal EventSource stub: captures the latest instance so a test can feed
// it wire frames; never errors (so the client stays on the SSE path).
class FakeEventSource {
  static latest: FakeEventSource | null = null
  url: string
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.latest = this
  }
  close(): void {}
  emit(sig: Signal): void {
    this.onmessage?.({ data: JSON.stringify(sig) })
  }
}

let client: BridgeClient | null = null

beforeEach(() => {
  postedLines = []
  historyLines = []
  serverTotal = 0
  health = {
    ok: true,
    mode: 'classifier',
    signals_sent: 0,
    classified: 0,
    delivered: 0,
    reflex_ready: true,
    session_ended: false
  }
  installFetchMock()
  ;(globalThis as Record<string, unknown>).EventSource = FakeEventSource
  FakeEventSource.latest = null
})

afterEach(() => {
  client?.dispose()
  client = null
})

function makeClient(extra: Partial<Parameters<typeof createBridgeClient>[0]> = {}): BridgeClient {
  client = createBridgeClient({
    endpoint: BASE,
    token: 'test-token',
    params: { flushMs: 25 },
    ...extra
  })
  return client
}

test('forwards completed sentences and holds the trailing partial', async () => {
  const c = makeClient()
  c.activate()
  c.pushSegments([
    { id: 'seg_1', speaker: 'Ada', text: 'Hello there. And then we' }
  ])
  await sleep(120) // a few flush ticks
  const speech = postedLines.filter((l) => l.kind !== 'control')
  assert.equal(speech.length, 1)
  assert.equal(speech[0]?.text, 'Hello there.')
  assert.equal(speech[0]?.speaker, 'Ada')
  // The session-config control line went out too (trigger marker included).
  const control = postedLines.find((l) => l.kind === 'control')
  assert.ok(control?.text.includes('[trigger: Claude]'))
})

test('a line naming the AI flushes immediately, including the open tail', async () => {
  const c = makeClient({ params: { flushMs: 5_000 } }) // no timer help
  c.activate()
  await sleep(50) // let activate settle (adopt → prime → config)
  c.pushSegments([
    { id: 'seg_1', speaker: 'Ada', text: 'Claude, what do you think' }
  ])
  await sleep(50) // the eager flush, not the 5 s timer
  const speech = postedLines.filter((l) => l.kind !== 'control')
  assert.equal(speech.length, 1)
  assert.equal(speech[0]?.text, 'Claude, what do you think')
})

test('pending signal opens a turn; the same id fills it in place', async () => {
  const c = makeClient()
  const turns: BridgeTurnEvent[] = []
  c.on('turn', (e) => turns.push(e))
  c.activate()
  await sleep(50)
  const es = FakeEventSource.latest
  assert.ok(es, 'SSE connected')
  es.emit({ idx: 0, type: 'present', text: 'Researching…', id: 'd1', pending: true, t: 1 })
  es.emit({ idx: 1, type: 'present', text: 'The answer is 42.', id: 'd1', t: 2 })
  // Replays of the same idx must be dropped (SSE backlog / poll overlap).
  es.emit({ idx: 1, type: 'present', text: 'The answer is 42.', id: 'd1', t: 2 })
  assert.equal(turns.length, 2)
  assert.equal(turns[0]?.action, 'open')
  assert.equal(turns[1]?.action, 'fill')
  assert.equal((turns[1] as { text: string }).text, 'The answer is 42.')
})

test('read receipts flip to heard from the classified cursor', async () => {
  const c = makeClient()
  let delivery: BridgeDeliveryEvent = {}
  c.on('delivery', (d) => (delivery = d))
  c.activate()
  c.pushSegments([{ id: 'seg_1', speaker: 'Ada', text: 'Fully settled line.' }])
  await sleep(120) // forwarded (seg mapped from the ack)
  assert.equal(delivery.seg_1, 'sent')
  health = { ...health, classified: serverTotal }
  await sleep(800) // one HEALTH_MS tick
  assert.equal(delivery.seg_1, 'heard')
})

test('drain mode reads the delivered cursor instead', async () => {
  health = { ...health, mode: 'drain', reflex_ready: false }
  const c = makeClient()
  let delivery: BridgeDeliveryEvent = {}
  const statuses: string[] = []
  c.on('delivery', (d) => (delivery = d))
  c.on('status', (s) => statuses.push(s.state))
  c.activate()
  c.pushSegments([{ id: 'seg_1', speaker: 'Ada', text: 'Fully settled line.' }])
  await sleep(120)
  health = { ...health, delivered: serverTotal }
  await sleep(800)
  assert.equal(delivery.seg_1, 'heard')
  // reflex_ready:false carries no weight in drain mode — no classifier error.
  assert.ok(!statuses.includes('classifier-unavailable'), statuses.join(','))
})

test('restored segments are archived, not re-forwarded', async () => {
  const c = makeClient({
    restored: [{ id: 'seg_1', speaker: 'Ada', text: 'Old line from last time.' }]
  })
  c.activate()
  c.pushSegments([{ id: 'seg_1', speaker: 'Ada', text: 'Old line from last time.' }])
  await sleep(120)
  // The restored line reaches /bridge/history (the passive archive) exactly
  // once, and NEVER the live transcript feed — a resume must not read in-room
  // as the AI re-reacting to old lines.
  assert.equal(historyLines.length, 1)
  assert.equal(historyLines[0]?.text, 'Old line from last time.')
  assert.equal(postedLines.filter((l) => l.kind !== 'control').length, 0)
})
