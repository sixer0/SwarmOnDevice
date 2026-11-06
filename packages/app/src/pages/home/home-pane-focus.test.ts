import { afterEach, describe, expect, test } from "bun:test"
import { createPaneFocusKeeper, shouldCloseOnWindowEscape } from "./home-pane-focus"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  document.body.innerHTML = ""
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The app as far as Esc cares: a composer, the pane (search box in a list that Suspense can take out) and a window listener. */
function app() {
  const composer = document.createElement("div")
  composer.contentEditable = "true"
  composer.tabIndex = 0
  const root = document.createElement("aside")
  root.tabIndex = -1
  const list = document.createElement("div")
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
    const esc = (init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: "Escape", cancelable: true, ...init })
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

describe("home pane focus keeper (row 15a)", () => {
  test("request() focuses the search box when it is mounted", () => {
    const a = app()
    const keeper = createPaneFocusKeeper(a.root)
    cleanups.push(keeper.dispose)
    keeper.request()
    expect(document.activeElement === a.input).toBe(true)
  })

  test("request() before the list is mounted focuses the pane, then the search box once it appears", async () => {
    const a = app()
    a.list.remove()
    const keeper = createPaneFocusKeeper(a.root)
    cleanups.push(keeper.dispose)
    keeper.request()
    expect(document.activeElement === a.root).toBe(true)
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === a.input).toBe(true)
  })

  test("a Suspense detach and re-insert of the same nodes gives focus back to the search box", async () => {
    const a = app()
    const keeper = createPaneFocusKeeper(a.root)
    cleanups.push(keeper.dispose)
    keeper.request()
    a.list.remove()
    await tick()
    expect(a.input.isConnected).toBe(false)
    expect(document.activeElement === a.input).toBe(false)
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === a.input).toBe(true)
  })

  test("focus moved to the composer during the detach stays in the composer", async () => {
    const a = app()
    const keeper = createPaneFocusKeeper(a.root)
    cleanups.push(keeper.dispose)
    keeper.request()
    a.list.remove()
    await tick()
    a.composer.focus()
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === a.composer).toBe(true)
  })

  test("a deliberate blur is not undone by a later detach and re-insert", async () => {
    const a = app()
    const keeper = createPaneFocusKeeper(a.root)
    cleanups.push(keeper.dispose)
    keeper.request()
    a.input.blur()
    await tick()
    a.list.remove()
    await tick()
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === document.body).toBe(true)
  })

  test("after dispose nothing is restored", async () => {
    const a = app()
    const keeper = createPaneFocusKeeper(a.root)
    keeper.request()
    a.list.remove()
    await tick()
    keeper.dispose()
    a.root.append(a.list)
    await tick()
    expect(document.activeElement === a.input).toBe(false)
  })
})
