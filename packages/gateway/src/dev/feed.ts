// Dev tool — simulates the live web session by replaying a transcript file into
// the running gateway over HTTP at a roughly speech-paced cadence. It pairs
// automatically by reading the gateway's token file (runtime.ts). Line format:
//   Speaker | utterance text     (a blank line is a pause; '#' is a comment)
//   @control | give the AI the floor   (a facilitator control line)
//
//   node src/bridge/dev/feed.ts [file]      (default: ./transcript.sample.txt)
//   FEED_SPEED=0.3 node src/bridge/dev/feed.ts   # ~3x faster than realtime

import { readFile } from 'node:fs/promises'
import { readInfo, latestInfo } from '../runtime.ts'

const speed = Number(process.env.FEED_SPEED) || 1
const file =
  process.argv[2] || new URL('./transcript.sample.txt', import.meta.url).pathname
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Pair to the running gateway: an explicit BRIDGE_PORT pins it, otherwise pick
// the most recently started one (the HTTP face lands on a dynamic port now).
const explicit = Number(process.env.BRIDGE_PORT) || 0
const info = explicit ? readInfo(explicit) : latestInfo()
if (!info) {
  process.stderr.write(
    `no running gateway found${explicit ? ` for port ${explicit}` : ''} — start it ` +
      'first (pnpm gateway, or Claude Code with the bridge MCP server, then ' +
      'GetSessionUrl / /brainstorm to boot the HTTP face).\n'
  )
  process.exit(1)
}
const base = `http://127.0.0.1:${info.port}`

async function post(path: string, body: unknown): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': info!.token },
        body: JSON.stringify(body || {})
      })
      return
    } catch {
      await sleep(1000) // gateway not up yet — retry
    }
  }
  throw new Error(`could not reach gateway at ${base}`)
}

const raw = await readFile(file, 'utf8')
process.stdout.write(`feeding ${file} → ${base}\n`)
for (const line0 of raw.split('\n')) {
  const line = line0.replace(/\r$/, '')
  if (line.trim() === '') {
    await sleep(2500 * speed)
    continue
  }
  if (line.trim().startsWith('#')) continue
  const m = line.match(/^([^|]+)\|\s?(.*)$/)
  const rawSpeaker = m ? m[1]!.trim() : 'Speaker'
  const text = m ? m[2]! : line.trim()
  const isControl = rawSpeaker.startsWith('@')
  const speaker = isControl ? rawSpeaker.slice(1) || 'facilitator' : rawSpeaker
  await post('/bridge/transcript', {
    speaker,
    text,
    kind: isControl ? 'control' : 'speech'
  })
  process.stdout.write(`${isControl ? '⎈' : '>'} ${speaker}: ${text}\n`)
  await sleep(Math.max(1200, text.length * 45) * speed)
}
await post('/bridge/end', {})
process.stdout.write('--- transcript ended ---\n')
