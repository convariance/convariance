// Live-chat with Claude Code over the convariance bridge, built directly on
// @convariance/client. Pairing: paste the launch URL GetSessionUrl printed —
// its ORIGIN is the gateway endpoint, `?session` keys the round, and the
// pairing token rides the #fragment (parseLaunchParams reads all three). Each
// sent message becomes one transcript segment; the agent's typed contributions
// stream back as `turn` events, with read receipts from `delivery` and
// liveness from `presence`. This page is fully static — the gateway runs on
// the user's machine and this SPA can be served from anywhere (GitHub Pages
// included) as long as its origin is in the gateway's BRIDGE_ALLOWED_ORIGINS.

import { createBridgeClient, parseLaunchParams } from '@convariance/client'
import type {
  BridgeClient,
  BridgeDeliveryEvent,
  BridgePresenceEvent,
  BridgeSegment,
  BridgeStatusEvent,
  BridgeTurnEvent
} from '@convariance/client'

interface Pairing {
  endpoint: string
  token: string
  session: string | null
  title: string | null
  name: string
}

const STORAGE_KEY = 'convariance-chat-pairing'

const ICONS: Record<string, string> = {
  candidate: '💡',
  insight: '🔎',
  caution: '⚠️',
  present: '🗣️',
  note: '📝'
}

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

const connectView = $('connect')
const connectForm = $<HTMLFormElement>('connect-form')
const launchInput = $<HTMLInputElement>('launch-url')
const nameInput = $<HTMLInputElement>('display-name')
const connectError = $('connect-error')
const chatView = $('chat')
const chatTitle = $('chat-title')
const presenceEl = $('presence')
const statusDot = $('status-dot')
const statusText = $('status-text')
const leaveBtn = $<HTMLButtonElement>('leave')
const messagesEl = $('messages')
const bannerEl = $('banner')
const composer = $<HTMLFormElement>('composer')
const input = $<HTMLInputElement>('input')

// --- pairing -----------------------------------------------------------------

function loadPairing(): Pairing | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Pairing) : null
  } catch {
    return null
  }
}

function savePairing(p: Pairing | null): void {
  if (p) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  else sessionStorage.removeItem(STORAGE_KEY)
}

/** Turn a pasted launch URL into a pairing (endpoint = the URL's origin). */
function pairingFromLaunchUrl(href: string, name: string): Pairing {
  const url = new URL(href) // throws on garbage — caught by the caller
  const params = parseLaunchParams(href)
  if (!params.token) {
    throw new Error(
      'No pairing token in that URL — paste the full launch URL including ' +
        'the #token=… fragment.'
    )
  }
  return {
    endpoint: url.origin,
    token: params.token,
    session: params.session,
    title: params.title,
    name: name.trim() || 'You'
  }
}

function showConnect(error?: string): void {
  chatView.hidden = true
  connectView.hidden = false
  connectError.hidden = !error
  connectError.textContent = error ?? ''
  launchInput.focus()
}

// --- chat --------------------------------------------------------------------

function startChat(pairing: Pairing): void {
  connectView.hidden = true
  chatView.hidden = false
  chatTitle.textContent = pairing.title || 'Live session'
  input.focus()

  const segments: BridgeSegment[] = []
  const ticks = new Map<string, HTMLElement>()
  let seq = 0
  let client: BridgeClient

  try {
    client = createBridgeClient({
      endpoint: pairing.endpoint,
      token: pairing.token,
      ...(pairing.session
        ? { session: { id: pairing.session, ...(pairing.title ? { title: pairing.title } : {}) } }
        : {}),
      // Typed chat: a message is complete the moment it is sent, so don't hold
      // an unpunctuated line back the way the speech tail-idle backstop would.
      params: { flushMs: 150, tailIdleMs: 300 }
    })
  } catch (e) {
    savePairing(null)
    showConnect((e as Error).message)
    return
  }

  function scrollDown(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function addUserMessage(text: string, segId: string): void {
    const row = document.createElement('div')
    row.className = 'msg user'
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = text
    const tick = document.createElement('span')
    tick.className = 'tick'
    tick.title = 'sending…'
    row.append(bubble, tick)
    ticks.set(segId, tick)
    messagesEl.append(row)
    scrollDown()
  }

  function aiRow(id: string): HTMLElement | null {
    return messagesEl.querySelector(`[data-turn="${CSS.escape(id)}"]`)
  }

  function addAiMessage(opts: {
    id: string
    type: string
    text: string
    detail?: string
    pending?: boolean
  }): void {
    const row = document.createElement('div')
    row.className = `msg ai${opts.pending ? ' pending' : ''}`
    row.dataset.turn = opts.id
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.textContent = ICONS[opts.type] ?? '·'
    badge.title = opts.type
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    const body = document.createElement('p')
    body.className = 'body'
    body.textContent = opts.text
    bubble.append(body)
    if (opts.detail) {
      const detail = document.createElement('p')
      detail.className = 'detail'
      detail.textContent = opts.detail
      bubble.append(detail)
    }
    row.append(badge, bubble)
    messagesEl.append(row)
    scrollDown()
  }

  function onTurn(turn: BridgeTurnEvent): void {
    if (turn.action === 'open') {
      addAiMessage({
        id: turn.id,
        type: turn.type,
        text: turn.label + (turn.queued ? ' (queued)' : ''),
        ...(turn.detail ? { detail: turn.detail } : {}),
        pending: true
      })
    } else if (turn.action === 'update') {
      const row = aiRow(turn.id)
      const body = row?.querySelector('.body')
      if (body && turn.label) {
        body.textContent = turn.label + (turn.queued ? ' (queued)' : '')
      }
    } else if (turn.action === 'fill') {
      const row = aiRow(turn.id)
      const body = row?.querySelector('.body')
      if (row && body) {
        row.classList.remove('pending')
        body.textContent = turn.text
        scrollDown()
      } else {
        addAiMessage({ id: turn.id, type: 'present', text: turn.text })
      }
    } else {
      addAiMessage({
        id: turn.id,
        type: turn.type,
        text: turn.text,
        ...(turn.detail ? { detail: turn.detail } : {})
      })
    }
  }

  function onDelivery(delivery: BridgeDeliveryEvent): void {
    for (const [segId, state] of Object.entries(delivery)) {
      const tick = ticks.get(segId)
      if (!tick) continue
      tick.textContent = state === 'heard' ? '✓✓' : '✓'
      tick.title = state === 'heard' ? 'heard by the agent' : 'received by the gateway'
      tick.classList.toggle('heard', state === 'heard')
    }
  }

  function onPresence(p: BridgePresenceEvent): void {
    const agent =
      p.agent === 'working'
        ? 'working…'
        : p.agent === 'connected'
          ? 'listening'
          : 'not connected — is it parked on WaitForTranscript?'
    presenceEl.textContent = `Claude Code · ${agent}`
  }

  function onStatus(status: BridgeStatusEvent): void {
    statusDot.className = `dot ${status.state}`
    statusText.textContent = status.state
    if (status.state === 'token-rejected') {
      client.dispose()
      savePairing(null)
      showConnect('The gateway rejected the pairing token — paste a fresh launch URL.')
      return
    }
    if (status.state === 'ended') {
      bannerEl.textContent =
        'The session ended (the agent left or another window took over). ' +
        'Ask Claude for a new launch URL to chat again.'
      bannerEl.hidden = false
      input.disabled = true
    } else if (status.state === 'offline') {
      bannerEl.textContent = 'Gateway unreachable — is Claude Code still running? Retrying…'
      bannerEl.hidden = false
    } else {
      bannerEl.hidden = true
      input.disabled = false
    }
  }

  client.on('turn', onTurn)
  client.on('delivery', onDelivery)
  client.on('presence', onPresence)
  client.on('status', onStatus)
  client.activate()

  composer.onsubmit = (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    const segId = `m_${Date.now().toString(36)}_${seq++}`
    segments.push({ id: segId, speaker: pairing.name, text })
    addUserMessage(text, segId)
    client.pushSegments([...segments])
  }

  leaveBtn.onclick = () => {
    client.dispose() // ends the round: POST /bridge/end, the agent stops listening
    savePairing(null)
    messagesEl.replaceChildren()
    showConnect()
  }
}

// --- boot ----------------------------------------------------------------------

connectForm.onsubmit = (e) => {
  e.preventDefault()
  try {
    const pairing = pairingFromLaunchUrl(launchInput.value.trim(), nameInput.value)
    savePairing(pairing)
    launchInput.value = ''
    startChat(pairing)
  } catch (err) {
    showConnect(
      err instanceof Error && err.message.includes('token')
        ? err.message
        : 'That does not look like a launch URL — paste the full URL Claude printed.'
    )
  }
}

// A launch URL can also target this page directly (?session=…#token=… plus
// ?bridge=<gateway origin>): a host that serves the SPA elsewhere can hand out
// deep links. Fall back to the saved pairing, then the connect screen.
const own = parseLaunchParams(window.location.href)
const bridgeParam = new URL(window.location.href).searchParams.get('bridge')
if (own.present && own.token && bridgeParam) {
  const pairing: Pairing = {
    endpoint: new URL(bridgeParam).origin,
    token: own.token,
    session: own.session,
    title: own.title,
    name: 'You'
  }
  history.replaceState(null, '', window.location.pathname)
  savePairing(pairing)
  startChat(pairing)
} else {
  const saved = loadPairing()
  if (saved) startChat(saved)
  else showConnect()
}
