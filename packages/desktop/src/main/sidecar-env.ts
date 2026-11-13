// The opencode sidecar's environment (moved here from server.ts by row 33, so it is testable without Electron).
//
// Row 33 adds the render bridge pair (file_requests row24 line: "add bridge.env DATUM_RENDER_SOCKET/DATUM_RENDER_TOKEN in
// createSidecarEnv"). The DATUM skill's datum-python runs in the agent's shell, a child of the sidecar, and reaches the
// bridge only through these two variables (names register R11: "DATUM_RENDER_* reach datum-python only through the
// sidecar"). The DATUM Studio endpoint needs nothing here: the built-in `datum-studio` MCP entry runs the launcher,
// which finds `<XDG_STATE_HOME>/swarm/datum-studio.env` through the XDG_STATE_HOME the sidecar already gets
// (sidecar.ts prepareSidecarEnv), and the Studio token stays in that 0600 file, never in this environment.

import { isAbsolute } from "node:path"
import { existingDefaultProjectDir } from "./onboarding-test-root"

export const RENDER_SOCKET_KEY = "DATUM_RENDER_SOCKET"
/** N8-443 (AC-PROJa, 1.2.8 row 25): the absolute Default Project root, read by the server's re-home route. Not a secret. */
export const DEFAULT_PROJECT_DIR_KEY = "SWARM_DEFAULT_PROJECT_DIR"
export const RENDER_TOKEN_KEY = "DATUM_RENDER_TOKEN"

export type RenderEnv = { DATUM_RENDER_SOCKET: string; DATUM_RENDER_TOKEN: string }

/** startRenderBridge's pair: an absolute socket path and the 32-byte hex token (datum-render/index.ts:61-65). */
export function isRenderEnv(value: unknown): value is RenderEnv {
  if (!value || typeof value !== "object") return false
  const socket = (value as Record<string, unknown>)[RENDER_SOCKET_KEY]
  const token = (value as Record<string, unknown>)[RENDER_TOKEN_KEY]
  return (
    typeof socket === "string" && socket.startsWith("/") && !/[\0\r\n]/.test(socket) && typeof token === "string" && /^[0-9a-f]{64}$/.test(token)
  )
}

export function createSidecarEnv(
  base: NodeJS.ProcessEnv,
  render?: RenderEnv,
  platform: NodeJS.Platform = process.platform,
  // undefined: this launch's Default Project when it exists as a folder (the test root's under test onboarding,
  // R-7); null: none. An explicit path is passed through.
  defaultProject: string | null | undefined = existingDefaultProjectDir(),
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(base).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (platform === "linux") delete env.LD_PRELOAD
  // Only this launch's bridge may be named: a pair inherited from the login shell (preferAppEnv) points at a socket of
  // some other process, so it is dropped even when this launch has no bridge.
  delete env[RENDER_SOCKET_KEY]
  delete env[RENDER_TOKEN_KEY]
  if (isRenderEnv(render)) {
    env[RENDER_SOCKET_KEY] = render.DATUM_RENDER_SOCKET
    env[RENDER_TOKEN_KEY] = render.DATUM_RENDER_TOKEN
  }
  // Only this launch's Default Project may be named: an inherited value (login shell, a parent test) is dropped first.
  delete env[DEFAULT_PROJECT_DIR_KEY]
  if (defaultProject && isAbsolute(defaultProject) && !/[\0\r\n]/.test(defaultProject)) env[DEFAULT_PROJECT_DIR_KEY] = defaultProject
  return env
}

/**
 * Hands the bridge's pair from the DATUM Studio start (which owns the bridge, datum-studio-host/start.ts) to the sidecar
 * spawn. `track` wraps the bridge start; `wait` gives the pair, or undefined when the bridge failed or did not start
 * within `timeoutMs`, so the sidecar never waits longer than that (renders then fail BROWSER_UNAVAILABLE, as without
 * a bridge).
 */
export function createRenderEnvGate() {
  let settle!: (env: RenderEnv | undefined) => void
  const settled = new Promise<RenderEnv | undefined>((resolve) => {
    settle = resolve
  })
  const publish = (env: unknown) => settle(isRenderEnv(env) ? env : undefined)
  return {
    publish,
    track<T extends { env: unknown }>(start: Promise<T>): Promise<T> {
      return start.then(
        (bridge) => {
          publish(bridge.env)
          return bridge
        },
        (error) => {
          publish(undefined)
          throw error
        },
      )
    },
    wait(timeoutMs: number): Promise<RenderEnv | undefined> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      })
      return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
    },
  }
}

export type RenderEnvGate = ReturnType<typeof createRenderEnvGate>
