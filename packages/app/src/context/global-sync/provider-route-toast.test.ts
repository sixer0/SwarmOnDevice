// Swarm 1.2.6 integration pass INT-1 item 3 (row 34a follow-up, SEC-08): the opencode server announces
// PROVIDER_ROUTE_UNVERIFIED as a `tui.toast.show` event (provider/route-check.ts defaultSink). The desktop app showed
// nothing; it now maps that event to its existing showToast (no new panel). Other TUI toasts stay TUI-only.
import { describe, expect, test } from "bun:test"

const mod: Record<string, unknown> = await import("./provider-route-toast").catch(() => ({}))
const providerRouteToast = mod.providerRouteToast as
  | ((event: { type: string; properties?: unknown }) => Record<string, unknown> | undefined)
  | undefined

const routeEvent = {
  type: "tui.toast.show",
  properties: {
    title: "GSP AI",
    message:
      "PROVIDER_ROUTE_UNVERIFIED: the route to the built-in AI (100.102.23.27) does not go through Tailscale. Requests are still sent, unencrypted. Connect Tailscale.",
    variant: "warning",
    duration: 10_000,
  },
}

describe("INT-1 item 3: PROVIDER_ROUTE_UNVERIFIED reaches the desktop toast", () => {
  test("the route warning event becomes a visible toast with the server's text", () => {
    expect(typeof providerRouteToast).toBe("function")
    const t = providerRouteToast!(routeEvent)
    expect(t).toBeDefined()
    expect(t!.title).toBe("GSP AI")
    expect(String(t!.description)).toStartWith("PROVIDER_ROUTE_UNVERIFIED:")
    expect(t!.variant).toBe("error")
    expect(t!.duration).toBe(10_000)
  })

  test("other TUI toasts and other events are not shown by the app", () => {
    expect(typeof providerRouteToast).toBe("function")
    expect(providerRouteToast!({ type: "tui.toast.show", properties: { message: "Session copied", variant: "success" } })).toBeUndefined()
    expect(providerRouteToast!({ type: "session.updated", properties: routeEvent.properties })).toBeUndefined()
    expect(providerRouteToast!({ type: "tui.toast.show" })).toBeUndefined()
    expect(providerRouteToast!({ type: "tui.toast.show", properties: { message: 42 } })).toBeUndefined()
  })
})
