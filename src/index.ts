// convariance — the main SDK. Everything here is zero-dependency and
// isomorphic (Node, workerd, browsers): the versioned wire protocol, the
// BridgeSession state machine, the Classifier seam, the segmenter, and the
// browser client. The Node-only gateway runtime lives in 'convariance/agent'.

export * from './core/index.ts'
export * from './client/index.ts'
