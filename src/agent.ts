// convariance/agent — the local Node gateway (programmatic surface). The
// shipped bin (cli.ts / `npx convariance`) runs direct-drain mode with the
// packaged web UI; import startGateway here to wire your own Classifier or a
// custom static UI bundle.

export { startGateway, type GatewayOptions } from './agent/gateway.ts'
export {
  createStaticHandler,
  type StaticHandler,
  type StaticHandlerOptions
} from './agent/static.ts'
export { agentActionsFor, browserActions, CTX_KEYS, type ReflexConfig } from './agent/actions.ts'
export { canOpenBrowser, openUrl, makeOpener } from './agent/launch.ts'
export { makeLog } from './agent/log.ts'
export {
  mintToken,
  loadBridgeEnv,
  writeInfo,
  readInfo,
  clearInfo,
  listInfos,
  latestInfo,
  type BridgeInfo
} from './agent/runtime.ts'
