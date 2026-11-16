// `GET /bridge/health` (row 48, plan M2-02; register rev 5 §4 "Bridge health"; server-delta spec §9.1 stage 9; SEC
// SC-13). The body is exactly `{ "bridge": "ok", "swarm": "ready" | "starting" | "down" }`: no session titles, paths,
// provider, port, version or error text (SC-13). The anti-CSRF check (stage 6) is admit's job and runs before this.

import { OFFICE_ERROR_ROUTE_NOT_ALLOWED, OFFICE_PATH_BRIDGE_HEALTH } from "@swarm/office-addin/constants"
import { errorResponse, jsonResponse, type BridgeRequestLine, type BridgeResponse } from "./static"

export type BridgeSwarmState = "ready" | "starting" | "down"
/** @internal test seam */
export const BRIDGE_SWARM_STATES: readonly BridgeSwarmState[] = ["ready", "starting", "down"]

type BridgeHealthBody = {
  bridge: "ok"
  swarm: BridgeSwarmState
}

function isBridgeSwarmState(value: unknown): value is BridgeSwarmState {
  return BRIDGE_SWARM_STATES.some((state) => state === value)
}

/** True when the request targets `/bridge/health` (any query is ignored for matching; admit rejects queries). */
/** @internal test seam */
export function isHealthRequest(request: BridgeRequestLine) {
  return request.url.split(/[?#]/, 1)[0] === OFFICE_PATH_BRIDGE_HEALTH
}

/** The registered body only. An unknown state reports `down` rather than echoing the input. */
/** @internal test seam */
export function healthBody(swarm: unknown): BridgeHealthBody {
  return { bridge: "ok", swarm: isBridgeSwarmState(swarm) ? swarm : "down" }
}

/** `GET` gives 200 with the body; any other method on the path is `404 ROUTE_NOT_ALLOWED`. Null when not the path. */
export function healthResponse(request: BridgeRequestLine, swarm: BridgeSwarmState): BridgeResponse | null {
  if (!isHealthRequest(request)) return null
  if (request.method !== "GET") return errorResponse(404, OFFICE_ERROR_ROUTE_NOT_ALLOWED)
  return jsonResponse(200, healthBody(swarm))
}
