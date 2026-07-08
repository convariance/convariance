// A no-network stand-in classifier for the smoke test: turns a
// `DELEGATE: <task>` transcript line into a delegation and marks every line
// classified (advancing the read-receipt cursor). Exercises every
// classifier-mode gateway path — WaitForDelegation, reflex_ready, receipts —
// through the public Classifier seam, with no model behind it. Also a minimal
// reference for writing a real classifier.

import type { BridgeSession, Classifier, ReflexParams } from '@convariance/core'

const STUB_PARAMS: ReflexParams = {
  debounceMs: 0,
  minIntervalMs: 0,
  windowLines: 0,
  maxTokens: 0,
  model: 'stub'
}

export function stubClassifier(session: BridgeSession): Classifier {
  let seq = 0
  const offTranscript = session.onTranscript((lines) => {
    for (const line of lines) {
      if (line.kind === 'control') continue
      const m = /^DELEGATE:\s*(.+)/i.exec(line.text)
      if (m?.[1]) {
        session.enqueueDelegation({
          id: `stub_${++seq}`,
          task: m[1].trim(),
          label: 'Working…'
        })
      }
      session.markClassified(line.seg)
    }
  })
  const offReset = session.onReset(() => {
    seq = 0
  })
  return {
    getParams: () => ({ ...STUB_PARAMS }),
    setParams: () => ({ ...STUB_PARAMS }),
    dispose() {
      offTranscript()
      offReset()
    }
  }
}
