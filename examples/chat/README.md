# convariance chat example

A minimal live-chat with Claude Code over the convariance bridge — one static
SPA built directly on [`@convariance/client`](../../packages/client), no
framework. Type into the composer and the agent hears you (drain mode:
it parks on `WaitForTranscript`); its typed contributions stream back as chat
bubbles with sent/heard ticks and live presence.

The page is fully static, so it can be served from anywhere — including
GitHub Pages. The gateway always runs on **your** machine; the page just
talks to it over loopback HTTP.

```
 you type ──▶ this SPA ──▶ @convariance/gateway (127.0.0.1) ──▶ Claude Code
                 ▲                    │
                 └──── typed signals ◀┘   (SSE)
```

## Run it

**1. Register the gateway** in any project's `.mcp.json` and start Claude Code
there:

```json
{
  "mcpServers": {
    "convariance": {
      "command": "npx",
      "args": ["-y", "@convariance/gateway"],
      "env": {
        "BRIDGE_ALLOWED_ORIGINS": "http://localhost:5173,https://convariance.github.io",
        "BRIDGE_NO_OPEN": "1"
      }
    }
  }
}
```

- `BRIDGE_ALLOWED_ORIGINS` must include the origin this page is served from
  (the gateway's CORS allowlist). `http://localhost:5173` covers local
  `pnpm dev`; add your GitHub Pages origin for the hosted page.
- `BRIDGE_NO_OPEN=1` stops the gateway auto-opening the launch URL in a
  browser — with an externally-hosted SPA there is nothing to open at the
  gateway's own origin.

**2. Start a session** — ask Claude Code something like:

> Join my live conversation: call GetSessionUrl, give me the URL, then keep
> listening with WaitForTranscript and contribute with SendSignal.

Claude prints a launch URL like
`http://127.0.0.1:7700/app/session?session=s_…#token=…`.

**3. Open the SPA and paste the launch URL.**

- Local dev: `pnpm install && pnpm -F convariance-chat-example dev` →
  http://localhost:5173
- Hosted: the repo's Pages deployment (built by
  `.github/workflows/pages.yml`).

The SPA reads the token from the URL fragment (`parseLaunchParams`), uses the
URL's origin as the gateway endpoint, and connects. Say hi — mention “Claude”
to address the AI directly (that also skips the forward debounce).

## How the client is used

Everything interesting is in [`src/main.ts`](src/main.ts):

- `createBridgeClient({ endpoint, token, session, params })` — one client per
  round. Typed chat sends complete messages, so the speech-oriented tail-idle
  backstop is tuned way down (`params: { flushMs: 150, tailIdleMs: 300 }`).
- Each sent message is one `BridgeSegment` (`{ id, speaker, text }`);
  `pushSegments(all)` is idempotent — the client tracks per-segment cursors.
- Events out: `turn` (the contribution lifecycle: `add`/`open`/`update`/`fill`),
  `delivery` (per-segment `sent`/`heard` read receipts), `presence`
  (agent listening/working), `status` (paired/offline/token-rejected/ended).
- `dispose()` ends the round (`POST /bridge/end`) — wired to the Leave button.

## Serving from HTTPS (GitHub Pages) — browser notes

An `https://` page calling `http://127.0.0.1` is allowed in Chromium and
Firefox (loopback is exempt from mixed-content blocking); Chromium may ask
for a local-network permission first. Safari blocks loopback from HTTPS pages —
use local dev (`pnpm dev`) there.
