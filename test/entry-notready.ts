// Smoke fixture: classifier mode whose factory reports not-ready (returns
// null — the "no API key" case). Classifier mode is all-or-nothing: a room
// whose front door can never react must not open, so GetSessionUrl must
// hard-fail rather than open a dead round.

import { startGateway } from '../src/agent/gateway.ts'

await startGateway({ classifier: () => null })
