// Unit tests for BridgeSession — the parts that bit us in live testing:
//   - the delegation QUEUE: a card opens "queued" and only flips to "working"
//     when the agent picks it up (no fleet of simultaneous spinners), de-dup of a
//     redundant ask, supersede of a still-queued one, one-delegation-at-a-time
//     sequencing.
//   - the durable EVENT LOG (v6): speech + completed cards under one monotonic
//     idx; pending placeholders and control lines excluded; incremental cursor.
// Pure logic (no model, no network, no timers) — run with `node --test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BridgeSession } from './session.ts'

function newSession(): BridgeSession {
  return new BridgeSession({ maxBlockSec: 50 })
}

const del = (text: string, task: string) =>
  ({ type: 'present' as const, text, task })

// Latest signal carrying a given id (cards are re-emitted in place under one id).
function latestForId(s: BridgeSession, id: string) {
  return s.signalsSince(0).filter((sig) => sig.id === id).at(-1)
}

test('delegate opens a QUEUED loading card (not a spinner) and enqueues work', () => {
  const s = newSession()
  const { action, id } = s.delegate(del('Checking Cloudflare…', 'check cloudflare for the transcript'))
  assert.equal(action, 'new')
  assert.ok(id)
  const card = latestForId(s, id!)
  assert.equal(card?.pending, true)
  assert.equal(card?.queued, true, 'a freshly-delegated card waits as "queued" until the agent takes it')
})

test('the card flips queued -> working only when the agent picks it up', async () => {
  const s = newSession()
  const { id } = s.delegate(del('Checking Cloudflare…', 'check cloudflare for the transcript'))
  assert.equal(latestForId(s, id!)?.queued, true)

  const handed = await s.waitForDelegation(1)
  assert.equal(handed.delegations.length, 1, 'agent gets exactly the one queued delegation')
  assert.equal(handed.delegations[0]?.id, id)
  assert.equal(latestForId(s, id!)?.queued, false, 'picked-up card now shows "working"')
  assert.equal(latestForId(s, id!)?.pending, true, 'still pending until the result fills it')
})

test('a near-duplicate of the ACTIVE delegation is skipped (no second card)', async () => {
  const s = newSession()
  s.delegate(del('Checking the market size…', 'research the Q3 market size for scooters'))
  await s.waitForDelegation(1) // make the delegation active
  const before = s.signalCount
  const dup = s.delegate(del('Checking the market size…', 'research the Q3 market size of scooters'))
  assert.equal(dup.action, 'skipped')
  assert.equal(s.signalCount, before, 'no new card opened for a redundant ask')
})

test('a near-duplicate of a still-QUEUED delegation supersedes it in place (one card, no pile-up)', () => {
  const s = newSession()
  const a = s.delegate(del('Researching market size…', 'research the Q3 market size for scooters'))
  const sup = s.delegate(del('Researching market size now…', 'research the Q3 market size for scooters in detail'))
  assert.equal(sup.action, 'superseded')
  assert.equal(sup.id, a.id, 'refines the same card id')
  // Both delegate calls emit under the SAME id — no second distinct loading card.
  const ids = new Set(s.signalsSince(0).map((sig) => sig.id))
  assert.equal(ids.size, 1)
})

test('two DISTINCT delegations queue and are handed ONE at a time', async () => {
  const s = newSession()
  const a = s.delegate(del('Checking Cloudflare storage…', 'check whether the transcript is on cloudflare'))
  const b = s.delegate(del('Summarizing the meeting…', 'write a summary of the whole meeting'))
  assert.equal(a.action, 'new')
  assert.equal(b.action, 'new')
  // Both cards exist; both start queued (the agent is idle, nothing picked up yet).
  assert.equal(latestForId(s, a.id!)?.queued, true)
  assert.equal(latestForId(s, b.id!)?.queued, true)

  const first = await s.waitForDelegation(1)
  assert.equal(first.delegations[0]?.id, a.id, 'oldest first')
  assert.equal(latestForId(s, a.id!)?.queued, false, 'A is working')
  assert.equal(latestForId(s, b.id!)?.queued, true, 'B still waits — not a second spinner')

  const second = await s.waitForDelegation(1) // retires A, hands B
  assert.equal(second.delegations[0]?.id, b.id)
  assert.equal(latestForId(s, b.id!)?.queued, false, 'B is working now')
})

test('event log: speech + completed cards interleave; control + pending excluded', () => {
  const s = newSession()
  s.pushTranscript([
    { speaker: 'Al', text: 'first line' },
    { speaker: 'Al', text: '[trigger: Claude]', kind: 'control' }
  ])
  s.addSignal({ type: 'insight', text: 'a real card' }) // logged
  s.addSignal({ type: 'present', text: 'Working…', pending: true }) // NOT logged

  const r = s.eventsSince(0)
  assert.equal(r.events.length, 2, 'control line + pending placeholder are excluded')
  assert.equal(r.events[0]?.kind, 'speech')
  assert.equal(r.events[0]?.text, 'first line')
  assert.equal(r.events[1]?.kind, 'card')
  assert.equal(r.events[1]?.cardType, 'insight')
  assert.equal(r.cursor, 2)
  assert.equal(r.total, 2)
})

test('event log is incremental and re-requestable (since:0 = full replay)', () => {
  const s = newSession()
  s.pushTranscript([{ speaker: 'Al', text: 'one' }])
  const r1 = s.eventsSince(0)
  assert.equal(r1.events.length, 1)
  // nothing new past the cursor
  assert.equal(s.eventsSince(r1.cursor).events.length, 0)
  // more arrives
  s.pushTranscript([{ speaker: 'Bo', text: 'two' }])
  assert.equal(s.eventsSince(r1.cursor).events.length, 1, 'only the new line')
  assert.equal(s.eventsSince(0).events.length, 2, 'since:0 replays everything')
})

test('reset() mints a new session id and clears the event log', () => {
  const s = newSession()
  const id1 = s.getSessionId()
  s.pushTranscript([{ speaker: 'Al', text: 'one' }])
  assert.equal(s.eventsSince(0).events.length, 1)
  s.reset()
  assert.notEqual(s.getSessionId(), id1, 'a fresh round gets a fresh id')
  assert.equal(s.eventsSince(0).events.length, 0, 'the in-memory log starts empty')
})

// Two-way connect (adopt): joining the live round must not disturb it; a
// different id means a different room and starts clean under that id.
test('adopt() with the live id is a no-op that lifts a stale ended flag', () => {
  const s = newSession()
  s.adopt('s_room')
  s.pushTranscript([{ speaker: 'Al', text: 'one' }])
  const before = s.eventsSince(0).events.length
  const { reset } = s.adopt('s_room')
  assert.equal(reset, false, 'same id must not reset the round')
  assert.equal(s.eventsSince(0).events.length, before, 'buffers untouched')
  s.end()
  s.adopt('s_room')
  assert.equal(s.status().session_ended, false, 'adopting the live id re-arms an ended round')
})

test('adopt() with a different id starts a clean round under it', () => {
  const s = newSession()
  s.pushTranscript([{ speaker: 'Al', text: 'old room' }])
  const { reset } = s.adopt('s_other')
  assert.equal(reset, true)
  assert.equal(s.getSessionId(), 's_other', 'the round keys on the adopted id')
  assert.equal(s.eventsSince(0).events.length, 0, 'the previous room\'s log is not carried over')
})
