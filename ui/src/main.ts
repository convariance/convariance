// Talk with Claude Code over the convariance bridge — type, or speak via the
// Web Speech API (speech.ts) — built directly on the convariance browser SDK.
// This page ships INSIDE the package: the gateway serves it same-origin at the
// launch URL GetSessionUrl prints (?session keys the round, the pairing token
// rides the #fragment), so opening that URL auto-pairs with zero setup. It is
// still fully static — a host can serve it from another origin (paste the
// launch URL, or deep-link with ?bridge=<gateway origin>) as long as that
// origin is in the gateway's BRIDGE_ALLOWED_ORIGINS. Typed and spoken input
// both become append-only transcript segments; the agent's contributions
// stream back as `turn` events, with read receipts from `delivery` and
// liveness from `presence`.

import { createBridgeClient, parseLaunchParams } from 'convariance'
import { createSpeechInput, speechAvailable } from './speech.ts'
import type {
  BridgeClient,
  BridgeDeliveryEvent,
  BridgePresenceEvent,
  BridgeSegment,
  BridgeStatusEvent,
  BridgeTurnEvent
} from 'convariance'

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
const micBtn = $<HTMLButtonElement>('mic')

/** A spoken pause this long closes the open mic segment — mirrors the core
 *  segmenter's pause threshold, and stays under the client's tailIdleMs so a
 *  resumed utterance starts a NEW segment instead of double-sending. */
const MIC_SEGMENT_GAP_MS = 3000

/** Typed messages are complete on send: ensure sentence-final punctuation so
 *  the client forwards them on the next flush tick instead of holding an
 *  unpunctuated line back behind the speech tail-idle backstop. */
function ensurePunctuated(text: string): string {
  return /[.?!…]["')\]]*$/.test(text) ? text : `${text}.`
}

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
      // flushMs 150 keeps typed chat snappy (it only gates already-complete
      // sentences); tailIdleMs 3200 is the speech knob — it holds a spoken,
      // unpunctuated trailing partial long enough not to shear a thought, and
      // stays ≥ MIC_SEGMENT_GAP_MS so continuations never double-send. Typed
      // messages bypass the backstop entirely via ensurePunctuated().
      params: { flushMs: 150, tailIdleMs: 3200 }
    })
  } catch (e) {
    savePairing(null)
    showConnect((e as Error).message)
    return
  }

  function scrollDown(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function addUserMessage(text: string, segId: string): HTMLElement {
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
    return bubble
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

  // --- mic input (Web Speech API) -------------------------------------------
  // Finals append to ONE open segment (append-only — the client forwards by
  // per-segment char cursor); a pause ≥ MIC_SEGMENT_GAP_MS closes it so the
  // next final opens a fresh segment/bubble. Interim text is volatile and only
  // ever rendered in a ghost bubble, never pushed.

  let micSeg: BridgeSegment | null = null
  let micBubble: HTMLElement | null = null
  let micLastFinal = 0
  let ghostRow: HTMLElement | null = null

  function renderInterim(text: string): void {
    if (!text) {
      ghostRow?.remove()
      ghostRow = null
      return
    }
    if (!ghostRow) {
      ghostRow = document.createElement('div')
      ghostRow.className = 'msg user ghost'
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      ghostRow.append(bubble)
    }
    ghostRow.firstElementChild!.textContent = text
    messagesEl.append(ghostRow) // re-append keeps it below the newest message
    scrollDown()
  }

  const speech = createSpeechInput({
    onFinal(text) {
      const now = Date.now()
      if (!micSeg || now - micLastFinal >= MIC_SEGMENT_GAP_MS) {
        const segId = `v_${now.toString(36)}_${seq++}`
        micSeg = { id: segId, speaker: pairing.name, text }
        segments.push(micSeg)
        micBubble = addUserMessage(text, segId)
      } else {
        micSeg.text += ` ${text}`
        if (micBubble) micBubble.textContent = micSeg.text
      }
      micLastFinal = now
      client.pushSegments([...segments])
      scrollDown()
    },
    onInterim: renderInterim,
    onStateChange(state) {
      micBtn.classList.toggle('listening', state === 'listening')
      micBtn.setAttribute('aria-pressed', String(state === 'listening'))
      if (state === 'denied') {
        bannerEl.textContent =
          'Microphone access was blocked — allow it in the browser and try again.'
        bannerEl.hidden = false
      }
      if (state !== 'listening') {
        micSeg = null
        micBubble = null
      }
    }
  })

  if (speechAvailable()) {
    micBtn.onclick = () => {
      if (micBtn.classList.contains('listening')) speech.stop()
      else speech.start()
    }
  } else {
    micBtn.disabled = true
    micBtn.title = 'Voice input needs the Web Speech API (Chrome or Edge) — typing works everywhere'
  }

  composer.onsubmit = (e) => {
    e.preventDefault()
    const raw = input.value.trim()
    if (!raw) return
    input.value = ''
    const text = ensurePunctuated(raw)
    micSeg = null // a typed message settles any open mic segment
    micBubble = null
    const segId = `m_${Date.now().toString(36)}_${seq++}`
    segments.push({ id: segId, speaker: pairing.name, text })
    addUserMessage(text, segId)
    client.pushSegments([...segments])
  }

  leaveBtn.onclick = () => {
    speech.stop()
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

// The primary flow: the gateway serves this page same-origin, so the launch
// URL GetSessionUrl prints (?session=…#token=…) lands here and auto-pairs
// against our own origin. A host serving the SPA elsewhere can still hand out
// deep links with ?bridge=<gateway origin>. Fall back to the saved pairing,
// then the paste-a-URL connect screen.
const own = parseLaunchParams(window.location.href)
const bridgeParam = new URL(window.location.href).searchParams.get('bridge')
if (own.present && own.token) {
  const pairing: Pairing = {
    endpoint: bridgeParam ? new URL(bridgeParam).origin : window.location.origin,
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
