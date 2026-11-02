import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { readFileSync } from "fs"
import { join } from "path"
import { dict } from "@/i18n/en"
import { asksNow, autonomyBlockedToast, composerMovedOn, todoDockAtBoundary, todoState } from "./session-composer-state"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

const held = (id: string, sessionID: string, at = 10) =>
  ({ id, sessionID, movedOnAt: at, deferred: true }) as PermissionRequest

// The two alert decisions live in `layout.tsx`, which cannot mount without the whole app: these fail if it stops asking.
const layoutSource = readFileSync(join(import.meta.dir, "../../layout.tsx"), "utf8")
const translate = ((key: keyof typeof dict, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
    dict[key],
  )) as Parameters<typeof autonomyBlockedToast>[0]["t"]

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("clears stale todos when the turn ends", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("clears completed todos when the session is no longer live", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("clear")
  })
})

describe("todoDockAtBoundary", () => {
  test("shows active todos when entering a session", () => {
    expect(todoDockAtBoundary("open")).toBe(true)
  })

  test("hides completed todos when entering a session", () => {
    expect(todoDockAtBoundary("close")).toBe(false)
  })
})

describe("a decision autonomous mode put aside (AU-36)", () => {
  const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

  test("permission.asked with deferred alerts nobody, even without movedOnAt", () => {
    expect(asksNow(held("p1", "root"))).toBe(false)
    expect(asksNow({ deferred: true })).toBe(false)
    expect(layoutSource).toContain("if (!asksNow(props)) return")
  })

  test("an ordinary request still alerts, and one the agent moved on from still does not", () => {
    expect(asksNow(permission("p1", "root"))).toBe(true)
    expect(asksNow({ movedOnAt: 5 })).toBe(false)
  })

  test("takes no prompt position", () => {
    expect(sessionPermissionRequest(sessions, { root: [held("p1", "root")] }, "root", asksNow)).toBeUndefined()
    expect(
      sessionPermissionRequest(sessions, { root: [held("p1", "root"), permission("p2", "root")] }, "root", asksNow)?.id,
    ).toBe("p2")
  })

  test("adds no dock row, for itself or from a subagent", () => {
    const rows = composerMovedOn(
      () => sessions,
      { root: [held("p1", "root")], child: [held("p2", "child")] },
      {},
      "root",
    )
    expect(rows).toEqual([])
  })

  test("the composer reads both through these rules, and the marker opens the decisions filter", () => {
    const composer = readFileSync(join(import.meta.dir, "session-composer-state.ts"), "utf8")
    expect(composer).toContain("sync().data.permission, params.id, asksNow)")
    expect(composer).toContain("return composerMovedOn(")
    const page = readFileSync(join(import.meta.dir, "../../session.tsx"), "utf8")
    expect(page).toMatch(/openDecisions: \(\) => \{\s+sessionMap\.setFilter\("decisions"\)\s+sessionMap\.open\(\)/)
  })

  test("leaves what the agent really went on without in the dock", () => {
    const moved = { ...permission("p2", "root"), movedOnAt: 20 }
    const asked = { ...question("q1", "child"), movedOnAt: 30 }
    const rows = composerMovedOn(() => sessions, { root: [held("p1", "root"), moved] }, { child: [asked] }, "root")
    expect(rows.map((item) => item.request.id)).toEqual(["p2", "q1"])
  })
})

describe("autonomy.blocked toast (AU-27)", () => {
  const toast = (current: boolean, open = () => {}) =>
    autonomyBlockedToast({ count: 3, sessionTitle: "Fix login", current, t: translate, open })

  test("layout shows it for the event and is not held back by the alert cooldown", () => {
    const branch = layoutSource.slice(
      layoutSource.indexOf('e.details?.type === "autonomy.blocked"'),
      layoutSource.indexOf('e.details?.type !== "permission.asked"'),
    )
    expect(branch).toContain("showToast(toast)")
    expect(branch).toContain("platform.notify(toast.title, toast.description")
    expect(branch).not.toContain("cooldownMs")
  })

  test("names the session and the count, and nothing else", () => {
    expect(toast(false).title).toBe(dict["notification.permission.title"])
    expect(toast(false).description).toBe("Fix login needs you. Decisions waiting: 3")
  })

  test("stays and links to the session from elsewhere", () => {
    const opened: string[] = []
    const away = toast(false, () => opened.push("session"))
    expect(away.persistent).toBe(true)
    expect(away.actions.map((action) => action.label)).toEqual([
      dict["notification.action.goToSession"],
      dict["common.dismiss"],
    ])
    const go = away.actions[0]!.onClick
    if (typeof go === "function") go()
    expect(opened).toEqual(["session"])
  })

  test("still shows on the open session, without a link to where you are", () => {
    const here = toast(true)
    expect(here.persistent).toBe(false)
    expect(here.actions.map((action) => action.label)).toEqual([dict["common.dismiss"]])
  })
})
