import { afterEach, describe, expect, test } from "bun:test"
import { focusPaneSearch, shouldCloseOnWindowEscape } from "./home-pane-focus"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  document.body.innerHTML = ""
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The app as far as Esc and focus care: a composer, the pane (search box in a list mounted later) and a window listener. */
function app() {
  const composer = document.createElement("div")
  composer.contentEditable = "true"
  composer.tabIndex = 0
  const root = document.createElement("aside")
  root.tabIndex = -1
  const list = document.createElement("div")
  list.setAttribute("data-component", "home-session-search")
  const input = document.createElement("input")
  list.append(input)
  root.append(list)
  document.body.append(composer, root)
  let closes = 0
  const listener = (event: KeyboardEvent) => {
    if (!shouldCloseOnWindowEscape(event, root)) return
    event.preventDefault()
    closes++
  }
  window.addEventListener("keydown", listener)
  cleanups.push(() => window.removeEventListener("keydown", listener))
  const press = (target: EventTarget, key = "Escape") =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  return { composer, root, list, input, press, closes: () => closes }
}

describe("home pane Esc at the window (row 15a)", () => {
  test("Esc with nothing focused closes the pane", () => {
    const a = app()
    expect(document.activeElement === document.body).toBe(true)
    a.press(document.body)
    expect(a.closes()).toBe(1)
  })

  test("Esc with focus in the chat composer does not close the pane", () => {
    const a = app()
    a.composer.focus()
    expect(document.activeElement === a.composer).toBe(true)
    a.press(a.composer)
    expect(a.closes()).toBe(0)
  })

  test("Esc already handled by a dialog or popover (defaultPrevented) does not close the pane", () => {
    const a = app()
    const popover = (event: KeyboardEvent) => event.preventDefault()
    document.addEventListener("keydown", popover)
    cleanups.push(() => document.removeEventListener("keydown", popover))
    a.press(document.body)
    expect(a.closes()).toBe(0)
  })

  test("Esc on the body while a dialog is open does not close the pane", () => {
    const a = app()
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.append(dialog)
    a.press(document.body)
    expect(a.closes()).toBe(0)
  })

  test("Esc with focus inside the pane closes it; another key does not", () => {
    const a = app()
    a.input.focus()
    a.press(a.input, "a")
    expect(a.closes()).toBe(0)
    a.press(a.input)
    expect(a.closes()).toBe(1)
  })

  test("literal cases of shouldCloseOnWindowEscape", () => {
    const a = app()
    const esc = (init: KeyboardEventInit = {}) =>
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true, ...init })
    expect(shouldCloseOnWindowEscape(esc(), a.root)).toBe(true)
    expect(shouldCloseOnWindowEscape(esc({ isComposing: true }), a.root)).toBe(false)
    expect(shouldCloseOnWindowEscape(new KeyboardEvent("keydown", { key: "Enter" }), a.root)).toBe(false)
    const handled = esc()
    handled.preventDefault()
    expect(shouldCloseOnWindowEscape(handled, a.root)).toBe(false)
    const field = document.createElement("input")
    document.body.append(field)
    field.focus()
    expect(shouldCloseOnWindowEscape(esc(), a.root)).toBe(false)
  })
})

describe("focusPaneSearch (row 15c)", () => {
  test("focuses the search box when it is mounted", () => {
    const a = app()
    cleanups.push(focusPaneSearch(a.root))
    expect(document.activeElement === a.input).toBe(true)
  })

  test("takes the keyboard out of the chat composer (decisions C10, D-3)", () => {
    const a = app()
    a.composer.focus()
    cleanups.push(focusPaneSearch(a.root))
    expect(document.activeElement === a.input).toBe(true)
  })

  test("before the box is mounted the pane holds focus, then the box once it appears", async () => {
    const a = app()
    a.list.remove()
    a.composer.focus()
    cleanups.push(focusPaneSearch(a.root))
    expect(document.activeElement === a.root).toBe(true)
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === a.input).toBe(true)
  })

  test("focus moved elsewhere while waiting stays there when the box appears", async () => {
    const a = app()
    a.list.remove()
    cleanups.push(focusPaneSearch(a.root))
    a.composer.focus()
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === a.composer).toBe(true)
  })

  test("after stop the box is not focused when it appears", async () => {
    const a = app()
    a.list.remove()
    const stop = focusPaneSearch(a.root)
    stop()
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === a.root).toBe(true)
  })

  test("an input of the pane that is not the search box is never chosen", () => {
    const a = app()
    a.list.remove()
    const other = document.createElement("input")
    a.root.append(other)
    cleanups.push(focusPaneSearch(a.root))
    expect(document.activeElement === a.root).toBe(true)
  })
})
