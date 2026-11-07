/**
 * Swarm addition (row 31c; decisions C60/C65; studio spec §4): PDF readiness for the render preflight
 * (`assertPdfRenderReady`, preflight.ts) and the R17 / rerender gate.
 *
 * In DATUM Studio for Swarm a PDF is printed only by the render bridge `pdf` op from Studio's own HTML
 * (row 32, `./pdf.ts`). So "the PDF engine is ready" means exactly: the bridge answers the `hello`
 * handshake with the shared token and reports a locked-down render window (engine/browser/runtime.ts
 * `bridgeHandshake` -> `judgeBridgeInfo`). The IBM Plex faces are served by the bridge itself
 * (`htmlWithFonts`), so no font check is made here. No other engine is consulted.
 *
 * The result is cached for `BRIDGE_READINESS_TTL_MS` (ready or not), like the original C15 cache;
 * preflight's `Retry-After` uses the same window. Never throws.
 */
import type { RenderEnvReadiness } from "../../contract";
import { bridgeHandshake } from "../../engine/browser/runtime";
import { errorMessageOf } from "./common";

/** What the preflight needs (`ReadinessFn` of preflight.ts). */
export type BridgePdfReadiness = Pick<RenderEnvReadiness, "ready" | "errors" | "checkedAt">;

export const BRIDGE_READINESS_TTL_MS = 30_000;

let cache: { at: number; value: BridgePdfReadiness } | null = null;

/** Drop the cached readiness (tests, or after the bridge restarts). */
export function resetBridgePdfReadiness(): void {
  cache = null;
}

/** Bridge readiness for PDF (cached; `force` skips the cache). */
export async function bridgePdfReadiness(opts?: { force?: boolean }): Promise<BridgePdfReadiness> {
  if (!opts?.force && cache && Date.now() - cache.at < BRIDGE_READINESS_TTL_MS) return cache.value;
  const errors: string[] = [];
  try {
    await bridgeHandshake();
  } catch (e) {
    errors.push(`render bridge not ready: ${errorMessageOf(e)}`);
  }
  const value: BridgePdfReadiness = { ready: errors.length === 0, errors, checkedAt: new Date().toISOString() };
  cache = { at: Date.now(), value };
  return value;
}
