// The browser SDK. Feed transcript segments in
// (pushSegments), get typed events out (turn / status / presence / delivery /
// signal / debug). Dependency-free by design: the host app owns rendering,
// persistence, and sound; this module owns the wire discipline.

export * from './bridgeClient.ts'
export * from './launchParams.ts'
