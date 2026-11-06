import { afterEach, describe, expect, test } from "bun:test"
import { homePaneEscape } from "./home-pane"

afterEach(() => {
  document.body.innerHTML = ""
})

/** The pane with its search box; the box answers Esc as on the Home page (prevent, clear, blur). */
function pane() {
  const closes: Array<Element | null> = []
  const aside = document.createElement("aside")
  const input = document.createElement("input")
  const rowEl = document.createElement("div")
  rowEl.tabIndex = 0
  aside.append(input, rowEl)
  document.body.append(aside)
  const escape = homePaneEscape(() => closes.push(document.activeElement))
  aside.addEventListener("keydown", escape.capture, true)
  let searchHandled = 0
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    searchHandled++
    event.preventDefault()
    input.value = ""
    input.blur()
  })
  aside.addEventListener("keydown", escape.keydown)
  const esc = (target: HTMLElement) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  return { input, row: rowEl, closes, esc, searchHandled: () => searchHandled }
}

describe("home pane Esc (M1)", () => {
  test("Esc in the empty search box closes the pane while focus is still inside it", () => {
    const p = pane()
    p.input.focus()
    p.esc(p.input)
    expect(p.closes.length).toBe(1)
    expect(p.closes[0] === p.input).toBe(true)
    expect(p.searchHandled()).toBe(0)
  })

  test("Esc in a search box with text only clears the search", () => {
    const p = pane()
    p.input.value = "fix"
    p.input.focus()
    p.esc(p.input)
    expect(p.closes.length).toBe(0)
    expect(p.searchHandled()).toBe(1)
    expect(p.input.value).toBe("")
  })

  test("Esc on a row closes the pane", () => {
    const p = pane()
    p.row.focus()
    p.esc(p.row)
    expect(p.closes.length).toBe(1)
  })

  test("other keys in the empty search box do nothing", () => {
    const p = pane()
    p.input.focus()
    p.input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }))
    expect(p.closes.length).toBe(0)
  })
})
