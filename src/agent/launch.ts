// Opening the room in the browser (PRD 007 launch UX). GetSessionUrl calls the
// opener; it auto-opens on a local desktop and stays quiet on remote/headless
// machines (SSH, no display) where popping a window is impossible or unwanted —
// the URL is always returned/printed regardless, so a remote user just clicks it.

import { spawn } from 'node:child_process'

/** Decide whether this process can sensibly open a desktop browser. */
export function canOpenBrowser(): boolean {
  const env = process.env
  // Explicit opt-out (set by the launcher's --no-open, or by the user).
  if (env.BRIDGE_NO_OPEN === '1' || env.BRIDGE_OPEN === '0') return false
  // Running over SSH — there is no local display to open into.
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false
  // Linux without an X/Wayland display is headless.
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return false
  }
  return true
}

/** Best-effort open of `url` in the default browser. Returns true if a launch
 *  was attempted (not whether a window actually appeared). */
export function openUrl(url: string): boolean {
  const platform = process.platform
  const cmd =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** An opener bound to the gateway's policy: opens locally, no-ops on remote. */
export function makeOpener(log: (...p: unknown[]) => void): (url: string) => boolean {
  const allowed = canOpenBrowser()
  return (url: string) => {
    if (!allowed) {
      log('remote/headless — not opening a window. Open the room yourself:')
      log(`  ${url}`)
      return false
    }
    const ok = openUrl(url)
    log(ok ? `opening the room: ${url}` : `could not open a browser — visit: ${url}`)
    return ok
  }
}
