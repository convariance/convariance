// One-tap pairing from a gateway launch URL. GetSessionUrl hands back a URL
// like
//   http://127.0.0.1:7700/?session=<id>&title=<name>#token=<pairing>
// The pairing token deliberately rides in the URL FRAGMENT so it never reaches
// a server (kept off request logs); session/title/debug are ordinary query
// params. The parse is pure (testable); `consumeLaunchParams` additionally
// strips the parameters from the address bar so the token doesn't linger in
// history. PERSISTING the values (storage, key records) is the host app's
// concern — this module only reads the wire.

export interface LaunchParams {
  /** The pairing bearer token from the fragment, or null. */
  token: string | null
  /** A session title carried from the launcher, or null. */
  title: string | null
  /** The server-minted session id (keys the durable event log), or null. */
  session: string | null
  /** True when the URL asked for the debug panel (`?debug=1`). */
  debug: boolean
  /** True when ANY launch parameter was present (callers gate persist+strip
   *  on this). */
  present: boolean
}

/** Parse a launch URL. Pure — pass any absolute URL string. */
export function parseLaunchParams(href: string): LaunchParams {
  const url = new URL(href)
  const frag = url.hash.startsWith('#')
    ? new URLSearchParams(url.hash.slice(1))
    : new URLSearchParams()
  const token = frag.get('token')
  const title = url.searchParams.get('title')
  const session = url.searchParams.get('session')
  const debugRaw = url.searchParams.get('debug')
  const debug = debugRaw === '1' || debugRaw === 'true'
  return {
    token,
    title,
    session,
    debug,
    present: Boolean(token || title || session || debugRaw)
  }
}

/** Read the launch params from the current location and, when any were
 *  present, strip them from the address bar (token + query gone, path route
 *  kept). Call once before the app mounts; persist what you need from the
 *  returned value. */
export function consumeLaunchParams(): LaunchParams {
  const params = parseLaunchParams(window.location.href)
  if (params.present) {
    history.replaceState(null, '', window.location.pathname)
  }
  return params
}
