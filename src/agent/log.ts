// stderr-only logger. The gateway's stdout is reserved for the JSON-RPC MCP
// stream — a stray stdout write corrupts it (learned in the Phase-B spike,
// PRD 007 F1). Everything diagnostic goes here, to stderr.

export function makeLog(tag: string) {
  return (...parts: unknown[]) => {
    process.stderr.write(`[${tag}] ${parts.map(String).join(' ')}\n`)
  }
}
