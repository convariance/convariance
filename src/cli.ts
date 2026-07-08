#!/usr/bin/env node
// The `convariance` bin — one command, two modes:
//
//   setup  (a human ran `npx convariance` in a terminal)
//     Registers the MCP server with Claude Code (`claude mcp add`, falling
//     back to merging .mcp.json in the cwd) and prints next steps. The ONLY
//     mode that writes files.
//
//   serve  (an MCP client spawned us over pipes — no TTY)
//     DIRECT-DRAIN gateway: stdio MCP + lazy HTTP face serving the packaged
//     web UI from the gateway's own loopback origin. stdout is reserved for
//     JSON-RPC; everything diagnostic goes to stderr (log.ts).
//
// Explicit `convariance setup` / `convariance serve` subcommands override the
// TTY detection (Git-Bash/mintty report no TTY; CI sets CI=1).
//
//   BRIDGE_DIST=<dir>   serve a custom UI bundle instead of the packaged one
//   BRIDGE_PORT/BRIDGE_TOKEN/BRIDGE_EAGER/…  see README

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startGateway } from './agent/gateway.ts'
import { createStaticHandler } from './agent/static.ts'
import { loadBridgeEnv } from './agent/runtime.ts'

const MCP_SERVER = { command: 'npx', args: ['-y', 'convariance'] }

const HELP = `convariance — an AI participant in your live conversation

Usage: convariance [command]

Commands:
  setup   register the MCP server with Claude Code (default in a terminal)
  serve   run the agent: stdio MCP bridge + web UI (default when spawned
          by an MCP client over pipes)

Options:
  -h, --help      show this help
  -v, --version   print the package version
`

function pkgVersion(): string {
  // ../package.json resolves from both dist/cli.js and src/cli.ts
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

/** The packaged UI: dist/ui sits next to dist/cli.js in the published layout;
 *  running from source (src/cli.ts) reaches the same directory one level up.
 *  BRIDGE_DIST always wins so a custom bundle can be swapped in. */
function resolveUiDir(): string {
  if (process.env.BRIDGE_DIST) return process.env.BRIDGE_DIST
  const candidates = [
    new URL('./ui/', import.meta.url),
    new URL('../dist/ui/', import.meta.url)
  ]
  for (const c of candidates) if (existsSync(c)) return fileURLToPath(c)
  return fileURLToPath(candidates[0])
}

async function serve(): Promise<void> {
  loadBridgeEnv()
  await startGateway({
    staticHandler: createStaticHandler(resolveUiDir(), {
      missingMessage: 'UI bundle missing — reinstall convariance (or run `pnpm build` in a source checkout)'
    })
  })
}

interface McpJson {
  mcpServers?: Record<string, { command?: string; args?: string[] }>
  [key: string]: unknown
}

/** Fallback when the `claude` CLI is unavailable: merge our server entry into
 *  ./.mcp.json, preserving everything else in the file. */
function writeMcpJson(): string {
  const path = join(process.cwd(), '.mcp.json')
  let config: McpJson = {}
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf8')) as McpJson
    } catch {
      throw new Error(`${path} exists but is not valid JSON — fix or remove it, then re-run`)
    }
  }
  const existing = config.mcpServers?.convariance
  if (existing?.command === MCP_SERVER.command
    && JSON.stringify(existing.args) === JSON.stringify(MCP_SERVER.args)) {
    return `already configured in ${path}`
  }
  config.mcpServers = { ...config.mcpServers, convariance: MCP_SERVER }
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return `${existing ? 'updated' : 'wrote'} ${path}`
}

function setup(): void {
  console.log(`convariance ${pkgVersion()} — setting up the Claude Code MCP server`)
  const add = spawnSync(
    'claude',
    ['mcp', 'add', '-s', 'local', 'convariance', '--', MCP_SERVER.command, ...MCP_SERVER.args],
    { stdio: 'inherit' }
  )
  if (add.error || add.status !== 0) {
    console.log('`claude mcp add` unavailable — falling back to .mcp.json')
    console.log(`✓ ${writeMcpJson()}`)
  } else {
    console.log('✓ registered MCP server \'convariance\' with Claude Code')
  }
  console.log(`
Next steps:
  1. start (or restart) claude in this project
  2. ask Claude to join your conversation — it calls GetSessionUrl and
     opens the chat UI in your browser (speak or type; no API keys needed)
`)
}

const { values, positionals } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' }
  },
  allowPositionals: true
})

if (values.help) {
  process.stdout.write(HELP)
} else if (values.version) {
  process.stdout.write(pkgVersion() + '\n')
} else {
  const command = positionals[0]
  if (command !== undefined && command !== 'setup' && command !== 'serve') {
    process.stderr.write(`unknown command: ${command}\n\n${HELP}`)
    process.exit(1)
  }
  const wantsSetup = command === 'setup'
    || (command === undefined && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI)
  if (wantsSetup) setup()
  else await serve()
}
