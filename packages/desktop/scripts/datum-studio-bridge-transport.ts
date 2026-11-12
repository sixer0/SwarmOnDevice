/**
 * Transport options of the DATUM Studio stdio bridge (1.2.6 row FX-4, review M2 finding S2).
 *
 * Kept in its own side-effect-free module: datum-studio-bridge.ts starts `main()` on load, so tests import the
 * options from here. `bun build scripts/datum-studio-bridge.ts --target=bun` inlines this file into the bundle.
 *
 * Measured (row FX-4 probe, bun 1.3.14, real time): Bun's `fetch` ends a request that receives no bytes for 300 s
 * with `TimeoutError` (code 23), whether the response headers have arrived or not. That is below the 540 s
 * `studio_render` budget (STUDIO_RENDER_CALL_TIMEOUT_MS, register N-044) and it also cut the session GET stream
 * after 300 s of silence, which the bridge reads as "host gone" (exit 3). With `timeout: false` the same fetch
 * carried a silent answer at 330 s and 545 s.
 *
 * So the bridge sets no transport idle limit of its own. The limits that end a slow call stay where the ladder puts
 * them: the host's R17 budget (540 s) answers with a named error first, and the MCP client's
 * `experimental.mcp_timeout` (600 s, N-071) is the outer bound (I-1). `BRIDGE_IDLE_LIMIT_FLOOR_MS` records that the
 * bridge path must hold a silent request at least that long; the config test pins both.
 */
export const BRIDGE_FETCH_OPTIONS = { timeout: false } as const

/** The bridge must not cut a silent request before this (= experimental.mcp_timeout, the ladder's outer bound). */
export const BRIDGE_IDLE_LIMIT_FLOOR_MS = 600_000
