#!/usr/bin/env node
// The standalone gateway entry: DIRECT-DRAIN mode — no classifier, no API key
// (PRD 018). An MCP client (Claude Code) launches this over stdio; the agent
// hears the room itself via WaitForTranscript and contributes via SendSignal.
//
//   BRIDGE_DIST=<dir>   serve a built web UI from the gateway's own loopback
//                       origin (same-origin transport; omit for headless use)
//   BRIDGE_PORT/BRIDGE_TOKEN/BRIDGE_EAGER/…  see the package README
//
// To run a classifier-fronted gateway (the reflex model), import
// `startGateway` from @convariance/gateway in your own entry and pass a
// `classifier` — see the Classifier interface in @convariance/core.

import { startGateway } from './gateway.ts'
import { createStaticHandler } from './static.ts'
import { loadBridgeEnv } from './runtime.ts'

// Load .env before reading BRIDGE_* config (startGateway loads it again —
// harmless, loadEnvFile never overrides existing vars).
loadBridgeEnv()

const dist = process.env.BRIDGE_DIST
await startGateway({
  staticHandler: dist ? createStaticHandler(dist) : undefined
})
