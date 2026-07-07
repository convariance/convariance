// Runtime discovery for the gateway's pairing token. The gateway mints a token
// at startup and writes a small info file under the OS temp dir, keyed by port.
// Local dev tools (smoke/feed/watch) read it back so they pair automatically;
// the real web app gets the token via the pairing UX (PRD 006). The long-lived
// token never leaves loopback.

import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'

export interface BridgeInfo {
  token: string
  port: number
  pid: number
  protocolVersion: number
  startedAt: number
}

/** A short, URL-safe bearer token. Friendly enough to type, random enough to
 *  resist guessing on loopback (PRD 007 §6). */
export function mintToken(): string {
  return randomBytes(9).toString('base64url')
}

/** Load a local .env into process.env (keys live there in dev) so the gateway
 *  sees them when an MCP client launches it — that spawn doesn't inherit a
 *  shell that sourced .env. Best-effort and idempotent: absent in prod, and
 *  never overrides a var the launching env already set. BRIDGE_NO_ENV=1 skips
 *  it (the smoke's hard-fail check needs a guaranteed keyless gateway,
 *  regardless of a developer's local .env). */
export function loadBridgeEnv(): void {
  if (process.env.BRIDGE_NO_ENV === '1') return
  try {
    process.loadEnvFile()
  } catch {
    // no .env — fine; rely on the ambient environment
  }
}

function infoPath(port: number): string {
  return join(tmpdir(), `convariance-bridge-${port}.json`)
}

export function writeInfo(info: BridgeInfo): string {
  const path = infoPath(info.port)
  writeFileSync(path, JSON.stringify(info), { mode: 0o600 })
  return path
}

export function readInfo(port: number): BridgeInfo | null {
  try {
    return JSON.parse(readFileSync(infoPath(port), 'utf8')) as BridgeInfo
  } catch {
    return null
  }
}

export function clearInfo(port: number): void {
  try {
    rmSync(infoPath(port))
  } catch {
    // already gone — fine
  }
}

/** Every gateway currently advertising a token file, newest first. With the
 *  HTTP face now on a dynamic port, sibling sessions write one file each; dev
 *  tools scan these instead of assuming 7700. */
export function listInfos(): BridgeInfo[] {
  let names: string[]
  try {
    names = readdirSync(tmpdir())
  } catch {
    return []
  }
  const infos: BridgeInfo[] = []
  for (const name of names) {
    const m = /^convariance-bridge-(\d+)\.json$/.exec(name)
    if (!m) continue
    const info = readInfo(Number(m[1]))
    if (info) infos.push(info)
  }
  return infos.sort((a, b) => b.startedAt - a.startedAt)
}

/** The most recently started gateway, or null if none is running. */
export function latestInfo(): BridgeInfo | null {
  return listInfos()[0] ?? null
}
