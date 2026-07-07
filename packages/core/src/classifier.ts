// The pluggable front-door classifier seam (PRD 018). The gateway core is
// classifier-agnostic: a Classifier is anything that subscribes to the session
// (onTranscript / onReset), decides the room's reaction, and acts through the
// public session surface — addSignal() for a card, delegate() to hand real
// work to the agent, markClassified() to advance the read-receipt cursor.
// Convariance Cloud's Haiku reflex is one implementation; the gateway
// runs equally well with none at all (direct-drain mode — the agent hears the
// room itself via WaitForTranscript).

import type { BridgeSession } from './session.ts'
import type { ReflexParams } from './protocol.ts'

/** A wired, running classifier. The params surface backs GET/POST
 *  /bridge/config (the Debug Panel's live tuning). */
export interface Classifier {
  /** Read the live tuning params. */
  getParams(): ReflexParams
  /** Patch the live tuning params; applies immediately, returns the new
   *  effective params. */
  setParams(partial: Partial<ReflexParams>): ReflexParams
  dispose(): void
}

/** Builds (and wires) a classifier onto the session. Called once at gateway
 *  start. Return null when the classifier cannot run (e.g. no API key) —
 *  the session then reports `reflex_ready: false` and GetSessionUrl hard-fails
 *  the round (classifier mode is all-or-nothing: a room whose front door can
 *  never react must not open). Omitting the factory entirely selects
 *  direct-drain mode instead. */
export type ClassifierFactory = (session: BridgeSession) => Classifier | null
