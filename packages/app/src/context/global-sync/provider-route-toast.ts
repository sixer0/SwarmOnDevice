import type { ToastOptions } from "@opencode-ai/ui/toast"

/**
 * Swarm 1.2.6 INT-1 (row 34a follow-up, SEC-08): the opencode server announces an unverified route to the bundled
 * provider as a `tui.toast.show` event whose message starts with `PROVIDER_ROUTE_UNVERIFIED:` (provider/route-check.ts,
 * at most once per 60 s per host). The desktop app shows it through its existing toast, where provider and session
 * status already surface (C9: no new panel). Every other TUI toast stays TUI-only.
 */
export const PROVIDER_ROUTE_UNVERIFIED = "PROVIDER_ROUTE_UNVERIFIED"

const MESSAGE_MAX = 400

export function providerRouteToast(event: { type: string; properties?: unknown }): ToastOptions | undefined {
  if (event.type !== "tui.toast.show") return
  const p = event.properties
  if (!p || typeof p !== "object") return
  const { title, message, duration } = p as Record<string, unknown>
  if (typeof message !== "string" || !message.startsWith(`${PROVIDER_ROUTE_UNVERIFIED}:`)) return
  return {
    title: typeof title === "string" && title.length > 0 ? title.slice(0, 80) : "GSP AI",
    description: message.slice(0, MESSAGE_MAX),
    // The UI toast has no warning variant; requests are sent unencrypted, so it uses the error look.
    variant: "error",
    duration: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : 10_000,
  }
}
