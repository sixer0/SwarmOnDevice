import { afterEach, describe, expect, test } from "bun:test"
import { isTextField, requestAgentBoardFocus, takeAgentBoardFocusRequest } from "./agent-board-controller"

afterEach(() => {
  // Drop anything a test left pending, and the DOM it built.
  takeAgentBoardFocusRequest(null)
  document.body.innerHTML = ""
})

const field = (tag: "input" | "textarea") => document.createElement(tag)
const editable = (value: string) => {
  const element = document.createElement("div")
  element.setAttribute("contenteditable", value)
  return element
}

describe("agent board focus request (H1)", () => {
  test("is taken once: a later board mount sees no request", () => {
    requestAgentBoardFocus()
    expect(takeAgentBoardFocusRequest(document.body)).toBe(true)
    expect(takeAgentBoardFocusRequest(document.body)).toBe(false)
  })

  test("without a request nothing is taken", () => {
    expect(takeAgentBoardFocusRequest(document.body)).toBe(false)
  })

  test("is refused while a text field has focus, and dropped rather than kept", () => {
    requestAgentBoardFocus()
    expect(takeAgentBoardFocusRequest(field("textarea"))).toBe(false)
    expect(takeAgentBoardFocusRequest(document.body)).toBe(false)
  })

  test("is refused for an input and a contenteditable composer", () => {
    requestAgentBoardFocus()
    expect(takeAgentBoardFocusRequest(field("input"))).toBe(false)
    requestAgentBoardFocus()
    expect(takeAgentBoardFocusRequest(editable("true"))).toBe(false)
  })
})

describe("isTextField", () => {
  test("literal cases", () => {
    const inner = document.createElement("span")
    const composer = editable("true")
    composer.append(inner)
    const button = document.createElement("button")
    expect(isTextField(field("input"))).toBe(true)
    expect(isTextField(field("textarea"))).toBe(true)
    expect(isTextField(composer)).toBe(true)
    expect(isTextField(editable(""))).toBe(true)
    expect(isTextField(inner)).toBe(true)
    expect(isTextField(editable("false"))).toBe(false)
    expect(isTextField(button)).toBe(false)
    expect(isTextField(document.body)).toBe(false)
    expect(isTextField(null)).toBe(false)
  })
})
