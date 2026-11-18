import { describe, expect, test } from "bun:test"
import { BRIDGE_SWARM_STATES, healthBody, healthResponse, isHealthRequest } from "./health"
import { BRIDGE_SECURITY_HEADERS } from "./static"

// Row 48 (plan M2-02). U-BR-14: `/bridge/health` body has exactly `{bridge, swarm}` with `swarm` in
// `ready`/`starting`/`down` (register rev 5 §4; SC-13: no user data).

const body = (response: ReturnType<typeof healthResponse>) =>
  JSON.parse(new TextDecoder().decode(response?.body ?? new Uint8Array()))

describe("U-BR-14 /bridge/health", () => {
  for (const state of ["ready", "starting", "down"] as const) {
    test(`swarm=${state}: 200, body is exactly {bridge:"ok", swarm}`, () => {
      const response = healthResponse({ method: "GET", url: "/bridge/health" }, state)
      expect(response?.status).toBe(200)
      expect(body(response)).toEqual({ bridge: "ok", swarm: state })
      expect(Object.keys(body(response)).sort()).toEqual(["bridge", "swarm"])
    })
  }

  test("the state set is the register's three values", () => {
    expect([...BRIDGE_SWARM_STATES]).toEqual(["ready", "starting", "down"])
  })

  test("an unknown state never leaks into the body; it reports down", () => {
    expect(healthBody("http://127.0.0.1:4096 password=x")).toEqual({ bridge: "ok", swarm: "down" })
    expect(healthBody(undefined)).toEqual({ bridge: "ok", swarm: "down" })
  })

  test("response carries the security headers (SC-07), JSON type and Content-Length; no CORS", () => {
    const response = healthResponse({ method: "GET", url: "/bridge/health" }, "ready")
    expect(response?.headers).toMatchObject(BRIDGE_SECURITY_HEADERS)
    expect(response?.headers["Content-Type"]).toBe("application/json; charset=utf-8")
    expect(response?.headers["Content-Length"]).toBe(String(response?.body?.byteLength))
    expect(Object.keys(response?.headers ?? {}).some((name) => name.toLowerCase().startsWith("access-control-"))).toBe(false)
  })

  test("other methods on the path are 404 ROUTE_NOT_ALLOWED; other paths are not this handler", () => {
    const post = healthResponse({ method: "POST", url: "/bridge/health" }, "ready")
    expect(post?.status).toBe(404)
    expect(body(post)).toEqual({ error: "ROUTE_NOT_ALLOWED" })
    expect(healthResponse({ method: "GET", url: "/bridge/healthz" }, "ready")).toBeNull()
    expect(healthResponse({ method: "GET", url: "/swarm/global/health" }, "ready")).toBeNull()
    expect(isHealthRequest({ method: "GET", url: "/bridge/health?x=1" })).toBe(true)
  })
})
