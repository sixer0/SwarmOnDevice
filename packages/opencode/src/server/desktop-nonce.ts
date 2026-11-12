// 1.2.6 row 38a (SEC-06, N-147): the per-launch desktop nonce. The desktop app makes it in Electron main for each launch,
// keeps it in memory only and hands it to this server in the sidecar's start message (row 38b), never through a file or
// the environment. An agent's shell can read the server password (`app-server.env`), but not this, so a route that needs
// both is one only the person at the app can reach. A server started any other way (`swarm serve`, `swarm run`) has
// none, and those routes refuse every caller.

import { createHash, timingSafeEqual } from "node:crypto"

/** The request header that carries the nonce (N-147). */
export const HEADER = "x-swarm-desktop-nonce"

// What the desktop sends: 32 random bytes as base64url is 43 characters. Anything shorter is too easy to guess.
const FORMAT = /^[A-Za-z0-9_-]{32,128}$/

// Held as its sha256, so a comparison always takes two equal-length buffers.
let held: Buffer | undefined

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest()

/** Takes the nonce of this launch, or forgets it with `undefined`. A value that is not a nonce is refused, not held. */
export function set(nonce: string | undefined) {
  if (nonce === undefined) {
    held = undefined
    return
  }
  if (!FORMAT.test(nonce)) throw new Error("The desktop nonce is not in the expected form")
  held = digest(nonce)
}

/** Whether this server was given a nonce at all. */
export function present() {
  return held !== undefined
}

/** True only when a nonce is held and the value is that nonce. Compared in constant time. */
export function matches(value: string | undefined) {
  if (!held || typeof value !== "string" || !FORMAT.test(value)) return false
  return timingSafeEqual(held, digest(value))
}

export * as DesktopNonce from "./desktop-nonce"
