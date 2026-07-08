---
'@convariance/gateway': patch
---

Upgrade `@silkweave/{core,fastify,mcp}` to 3.1.0. The silkweave adapters no
longer pull `@silkweave/logger`, so the gateway drops its `@clack/prompts`
dependency (it was only carried to satisfy that logger's unconditional
import) — a leaner install for consumers.
