// Mic transcription via the Web Speech API (Chrome/Edge; Safari 14.1+ behind
// webkit prefix) — no external STT service, the browser does the work. lib.dom
// ships no types for it, so a minimal ambient surface is declared here.
//
// Contract with the caller: interim results are VOLATILE (display-only —
// they mutate and must never enter a BridgeSegment, whose text is append-only
// once pushed); each final result is delivered exactly once via onFinal.

interface RecognitionAlternative {
  transcript: string
}

interface RecognitionResult {
  isFinal: boolean
  0: RecognitionAlternative
}

interface RecognitionResultEvent {
  resultIndex: number
  results: {
    length: number
    [index: number]: RecognitionResult
  }
}

interface RecognitionErrorEvent {
  error: string
}

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: RecognitionResultEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: RecognitionErrorEvent) => void) | null
  start(): void
  stop(): void
}

type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as RecognitionCtor | null
}

export function speechAvailable(): boolean {
  return recognitionCtor() !== null
}

export type SpeechState = 'idle' | 'listening' | 'denied' | 'error'

export interface SpeechInputOptions {
  /** BCP-47 tag; defaults to the browser's UI language. */
  lang?: string
  /** One finalized utterance chunk — safe to append to a transcript segment. */
  onFinal(text: string): void
  /** The current volatile tail — render only, never forward. '' clears it. */
  onInterim(text: string): void
  onStateChange(state: SpeechState): void
}

export interface SpeechInput {
  start(): void
  stop(): void
}

export function createSpeechInput(opts: SpeechInputOptions): SpeechInput {
  const Ctor = recognitionCtor()
  let active = false
  let rec: Recognition | null = null

  function boot(): void {
    if (!Ctor) return
    rec = new Ctor()
    rec.lang = opts.lang ?? navigator.language
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0].transcript.trim()
        if (!text) continue
        if (result.isFinal) opts.onFinal(text)
        else interim += (interim ? ' ' : '') + text
      }
      opts.onInterim(interim)
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        active = false
        opts.onInterim('')
        opts.onStateChange('denied')
      }
      // 'no-speech' / 'aborted' / 'network' fall through: onend decides
    }
    rec.onend = () => {
      opts.onInterim('')
      // Chrome ends continuous recognition after silence — restart while the
      // toggle is on so the mic behaves like a real open channel.
      if (active) rec?.start()
      else opts.onStateChange('idle')
    }
    rec.start()
  }

  return {
    start() {
      if (!Ctor || active) return
      active = true
      opts.onStateChange('listening')
      boot()
    },
    stop() {
      if (!active) return
      active = false
      rec?.stop()
    }
  }
}
