// Smoke fixture: a classifier-mode gateway wired with the no-network stub
// classifier — the smoke's main child. Mirrors how a real classifier entry
// wires startGateway (convariance's private reflex entry has this exact
// shape).

import { startGateway } from '../src/agent/gateway.ts'
import { stubClassifier } from './stubClassifier.ts'

await startGateway({ classifier: stubClassifier })
