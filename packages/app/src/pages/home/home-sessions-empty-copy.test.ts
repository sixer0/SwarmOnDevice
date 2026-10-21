import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import { homeSessionsEmptyDescriptionKey } from "@/pages/home/home-sessions-view"

// Mechanical proof for the second half of F-137-1 (row 172): on a project-less home the
// sessions pane invited "Create a session to get started" while offering no control to do
// it with (`A02_project_closed_via_ui.txt` lines "Nothing here yet" / "Create a session to
// get started" and no button; the judged text is `14_jury_flow.md` §6.1). The pane must now
// name an action whose affordance is actually on screen, using dictionary entries that
// already exist — this row owns no i18n file.

describe("homeSessionsEmptyDescriptionKey", () => {
  test("invites creating a session only when that affordance exists", () => {
    expect(homeSessionsEmptyDescriptionKey(true)).toBe("home.sessions.empty.description")
  })

  test("points at opening a project when no create-session affordance exists", () => {
    // The exact misleading imperative must not be chosen in this state.
    expect(homeSessionsEmptyDescriptionKey(false)).not.toBe("home.sessions.empty.description")
    expect(homeSessionsEmptyDescriptionKey(false)).toBe("home.empty.description")
  })

  test("both keys resolve in every shipped dictionary", () => {
    // Read-only guard against the merged i18n row later removing an entry this copy relies on.
    for (const key of ["home.sessions.empty.description", "home.empty.description"] as const) {
      expect(typeof en[key]).toBe("string")
      expect(en[key].length).toBeGreaterThan(0)
      expect(typeof id[key]).toBe("string")
      expect(id[key].length).toBeGreaterThan(0)
    }
  })

  test("the no-affordance copy names an action, not the missing one", () => {
    expect(en["home.empty.description"]).toBe("Get started by opening a local project")
  })
})
