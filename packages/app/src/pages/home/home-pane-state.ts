import { createSignal } from "solid-js"
import type { LayoutRoute } from "@/context/layout"

// Only solid-js at runtime: NewLayout imports this on every route, the pane itself is loaded on first open.

/** Home beside the chat: open or closed, in memory only, closed at app start. */
const [open, setOpen] = createSignal(false)
export const homePaneOpen = open

let returnFocus: HTMLElement | undefined
let paneRoot: HTMLElement | undefined
let focusOnOpen = false

export const setHomePaneRoot = (element: HTMLElement | undefined) => (paneRoot = element)

/** `focus`: put the keyboard in the pane's search (used when opened from the keyboard). */
export function openHomePane(options?: { focus?: boolean }) {
  if (open()) return
  focusOnOpen = !!options?.focus
  const active = typeof document === "undefined" ? undefined : document.activeElement
  returnFocus = active instanceof HTMLElement && active !== document.body ? active : undefined
  setOpen(true)
}

/** Read once by the pane when it mounts. */
export function takeHomePaneFocusRequest() {
  const value = focusOnOpen
  focusOnOpen = false
  return value
}

/** Closes the pane; when the keyboard was inside it, gives it back to where it was before, else the composer. */
export function closeHomePane() {
  if (!open()) return
  const focusWasInPane = !!paneRoot && typeof document !== "undefined" && paneRoot.contains(document.activeElement)
  const target = returnFocus
  returnFocus = undefined
  setOpen(false)
  if (!focusWasInPane) return
  const fallback = () => document.querySelector<HTMLElement>('[data-component="prompt-input"]') ?? undefined
  const next = target?.isConnected ? target : fallback()
  next?.focus()
}

export const isChatRoute = (route: LayoutRoute) => route.type !== "home"

export type HomeButtonAction = "recent" | "open" | "close"

/**
 * What the titlebar Home button does. On Home it goes back to the remembered tab, as before; over a chat it only
 * opens or closes the pane, so a chat route never navigates to "/" from this button.
 */
export function homeButtonAction(input: { route: LayoutRoute; paneOpen: boolean }): HomeButtonAction {
  if (!isChatRoute(input.route)) return "recent"
  return input.paneOpen ? "close" : "open"
}
