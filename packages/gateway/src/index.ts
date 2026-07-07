// @convariance/gateway — the local Node gateway (programmatic surface). The
// shipped bin (bin.ts / `convariance-gateway`) runs direct-drain mode; import
// startGateway here to wire your own Classifier or a static UI bundle.

export { startGateway, type GatewayOptions } from './gateway.ts'
export {
  createStaticHandler,
  type StaticHandler,
  type StaticHandlerOptions
} from './static.ts'
export { agentActionsFor, browserActions, CTX_KEYS, type ReflexConfig } from './actions.ts'
export { canOpenBrowser, openUrl, makeOpener, isRemote } from './launch.ts'
export { makeLog } from './log.ts'
export {
  mintToken,
  loadBridgeEnv,
  writeInfo,
  readInfo,
  clearInfo,
  listInfos,
  latestInfo,
  type BridgeInfo
} from './runtime.ts'
