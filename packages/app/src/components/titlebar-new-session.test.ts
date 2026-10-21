import { describe, expect, test } from "bun:test"
import { canCreateNewTab, newSessionClickHandler, type NewTabAvailability } from "./titlebar"

// Mechanical proof for F-137-1 (row 172). The judged defect: on a project-less home the
// titlebar "New session" control was enabled and swallowed the click with no toast,
// navigation or disabled state (`A03_new_session_button_on_empty_home.txt` shows only the
// tooltip appearing; `07_capture_flow.md` §4.1 A03 records URL unchanged). These tests pin
// the two properties whose absence allowed it: (1) availability is computed from the same
// three routes the handler itself needs, and (2) the click handler acts exactly when — and
// only when — that availability says the action is possible. An enabled no-op requires the
// disabled prop and the guard to disagree; both now read one signal.

const cases: Array<{ name: string; availability: NewTabAvailability; expectOpen: boolean }> = [
  {
    // Capture state A02/A03: home route, no session, no draft tab, project list empty
    // after closing the only project through the product's own menu.
    name: "project-less home (capture A03) cannot create a session",
    availability: { onActiveSession: false, onDraftTab: false, hasAnyProject: false },
    expectOpen: false,
  },
  {
    // Capture state A06/E01: a project exists, so openNewTab resolves a directory and works.
    name: "home with any project creates a session",
    availability: { onActiveSession: false, onDraftTab: false, hasAnyProject: true },
    expectOpen: true,
  },
  {
    name: "loaded session route inherits its directory",
    availability: { onActiveSession: true, onDraftTab: false, hasAnyProject: false },
    expectOpen: true,
  },
  {
    name: "draft tab route inherits its server and directory",
    availability: { onActiveSession: false, onDraftTab: true, hasAnyProject: false },
    expectOpen: true,
  },
]

describe("canCreateNewTab + newSessionClickHandler agree on every input", () => {
  for (const { name, availability, expectOpen } of cases) {
    test(name, () => {
      expect(canCreateNewTab(availability)).toBe(expectOpen)

      let opened = 0
      const click = newSessionClickHandler({
        canCreate: () => canCreateNewTab(availability),
        onOpen: () => {
          opened += 1
        },
      })
      click()
      // Enabled-but-does-nothing, or disabled-but-fires: both fail here.
      expect(opened).toBe(expectOpen ? 1 : 0)
    })
  }

  test("handler forwards repeated clicks while creation stays possible", () => {
    let opened = 0
    const click = newSessionClickHandler({
      canCreate: () => true,
      onOpen: () => {
        opened += 1
      },
    })
    click()
    click()
    expect(opened).toBe(2)
  })

  test("truth table: availability is the OR of the three directory-supplying routes", () => {
    for (const onActiveSession of [false, true]) {
      for (const onDraftTab of [false, true]) {
        for (const hasAnyProject of [false, true]) {
          const availability = { onActiveSession, onDraftTab, hasAnyProject }
          expect(canCreateNewTab(availability)).toBe(onActiveSession || onDraftTab || hasAnyProject)
        }
      }
    }
  })
})
