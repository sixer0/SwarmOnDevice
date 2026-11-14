// 1.2.8 row 44c, N8-366: AC-PROJd (part 1, client state follows `project.rehomed`) and AC-PROJe (part 2, the group
// shows as its own project entry). Synthetic paths only; no real storage, folder or server is touched. Assertions are
// counts, strings and booleans (C77).
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { ServerScope } from "@/utils/server-scope"

type Rehomed = typeof import("./project-rehomed")
type PersistMod = typeof import("@/utils/persist")
type ServerMod = typeof import("./server")

let R: Rehomed
let P: PersistMod
let S: ServerMod

const ROOT = "/syn/Default Project"
const GROUP = "/syn/Default Project/Lumen"
const MOVED = ["ses_moved_a", "ses_moved_b"]
const STAY = "ses_stay"
const KEYS = ["prompt", "comments", "file-view", "terminal"]

const event = (overrides: Record<string, unknown> = {}) => ({
  type: "project.rehomed",
  properties: { missionId: "M-syn-1", from: ROOT, to: GROUP, sessions: MOVED, journalId: "rh-1-abcd", ...overrides },
})

// A desktop-shaped platform: named storages and the draft store, all in one map so every key is visible.
const values = new Map<string, string>()
const named = (name?: string) => ({
  getItem: async (key: string) => values.get(`${name ?? "-"}|${key}`) ?? null,
  setItem: async (key: string, value: string) => void values.set(`${name ?? "-"}|${key}`, value),
  removeItem: async (key: string) => void values.delete(`${name ?? "-"}|${key}`),
})
const draftStore = Object.assign(named("draft-store"), { putBlob: async () => ({ id: "b", url: "blob:x" }) })
const platform = { platform: "desktop", storage: named, draftStore } as never

function slot(dir: string, session: string, key: string, draft = false) {
  const target = P.Persist.serverSession(ServerScope.local, dir, session, key)
  if (draft) return `draft-store|${target.storage}:${target.key}`
  return `${target.storage}|${target.key}`
}

function seed(dir: string, sessions: string[]) {
  for (const session of sessions) {
    for (const key of KEYS) values.set(slot(dir, session, key), `${key}:${session}`)
    values.set(slot(dir, session, "prompt", true), `draft-prompt:${session}`)
  }
}

function withProjects(run: (projects: ReturnType<ServerMod["createServerProjects"]>) => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = S.createServerProjects({ scope, store, setStore })
      projects.open(ROOT)
      run(projects)
        .then(resolve, reject)
        .finally(dispose)
    })
  })
}

beforeAll(async () => {
  mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
  R = await import("./project-rehomed")
  P = await import("@/utils/persist")
  S = await import("./server")
})

beforeEach(() => values.clear())

describe("AC-PROJd: client state follows project.rehomed (N8-366 part 1)", () => {
  test("the group joins the project list, the root stays", async () => {
    await withProjects(async (projects) => {
      await R.applyProjectRehomed({ event: event(), scope: ServerScope.local, platform, projects })
      const list = projects.list().map((p) => p.worktree)
      expect(list.length).toBe(2)
      expect(list.includes(GROUP)).toBe(true)
      expect(list.includes(ROOT)).toBe(true)
    })
  })

  test("Persist.session(from, id) keys, incl. the draft-store prompt, are copied to `to` and then removed", async () => {
    seed(ROOT, [...MOVED, STAY])
    values.set(`${P.Persist.serverWorkspace(ServerScope.local, ROOT, "terminal").storage}|workspace:terminal`, "root-ws")
    await withProjects(async (projects) => {
      const result = await R.applyProjectRehomed({ event: event(), scope: ServerScope.local, platform, projects })
      expect(result?.failed).toBe(0)
      expect(result?.moved).toBe(MOVED.length * KEYS.length)
    })
    for (const session of MOVED) {
      for (const key of KEYS) {
        expect(values.get(slot(GROUP, session, key))).toBe(`${key}:${session}`)
        expect(values.has(slot(ROOT, session, key))).toBe(false)
      }
      expect(values.get(slot(GROUP, session, "prompt", true))).toBe(`draft-prompt:${session}`)
      expect(values.has(slot(ROOT, session, "prompt", true))).toBe(false)
    }
    // A session that did not move and the root's workspace state stay where they were.
    for (const key of KEYS) expect(values.get(slot(ROOT, STAY, key))).toBe(`${key}:${STAY}`)
    expect(values.get(slot(ROOT, STAY, "prompt", true))).toBe(`draft-prompt:${STAY}`)
    expect(values.get(`${P.Persist.serverWorkspace(ServerScope.local, ROOT, "terminal").storage}|workspace:terminal`)).toBe(
      "root-ws",
    )
  })

  test("other windows are idempotent: a second event changes nothing and an existing `to` value is kept", async () => {
    seed(ROOT, MOVED)
    values.set(slot(GROUP, MOVED[0]!, "comments"), "newer-in-group")
    await withProjects(async (projects) => {
      await R.applyProjectRehomed({ event: event(), scope: ServerScope.local, platform, projects })
      const before = JSON.stringify([...values.entries()].sort())
      const again = await R.applyProjectRehomed({ event: event(), scope: ServerScope.local, platform, projects })
      expect(again?.moved).toBe(0)
      expect(JSON.stringify([...values.entries()].sort())).toBe(before)
      expect(projects.list().length).toBe(2)
    })
    expect(values.get(slot(GROUP, MOVED[0]!, "comments"))).toBe("newer-in-group")
    expect(values.has(slot(ROOT, MOVED[0]!, "comments"))).toBe(false)
  })

  test("a failed copy removes nothing", async () => {
    seed(ROOT, [MOVED[0]!])
    const failing = {
      ...(platform as object),
      storage: (name?: string) => ({ ...named(name), setItem: async () => Promise.reject(new Error("disk full")) }),
      draftStore: { ...draftStore, setItem: async () => Promise.reject(new Error("disk full")) },
    } as never
    await withProjects(async (projects) => {
      const result = await R.applyProjectRehomed({
        event: event({ sessions: [MOVED[0]] }),
        scope: ServerScope.local,
        platform: failing,
        projects,
      })
      expect(result?.failed).toBe(KEYS.length)
    })
    for (const key of KEYS) expect(values.get(slot(ROOT, MOVED[0]!, key))).toBe(`${key}:${MOVED[0]}`)
    expect(values.get(slot(ROOT, MOVED[0]!, "prompt", true))).toBe(`draft-prompt:${MOVED[0]}`)
  })

  test("an open route of a moved session points at `to`; other routes are left alone", async () => {
    const payload = R.projectRehomedPayload(event())!
    expect(R.rehomedSessionPath(`/${base64Encode(ROOT)}/session/${MOVED[1]}`, payload)).toBe(
      `/${base64Encode(GROUP)}/session/${MOVED[1]}`,
    )
    expect(R.rehomedSessionPath(`/${base64Encode(ROOT)}/session/${STAY}`, payload)).toBe(undefined)
    expect(R.rehomedSessionPath(`/${base64Encode("/syn/other")}/session/${MOVED[1]}`, payload)).toBe(undefined)
    expect(R.rehomedSessionPath(`/${base64Encode(ROOT)}/session`, payload)).toBe(undefined)
    let heard = 0
    await withProjects(async (projects) => {
      await R.applyProjectRehomed({
        event: event(),
        scope: ServerScope.local,
        platform,
        projects,
        listeners: [(p) => void (heard += p.to === GROUP ? 1 : 0)],
      })
    })
    expect(heard).toBe(1)
  })

  test("other events and malformed payloads do nothing", async () => {
    seed(ROOT, MOVED)
    const count = values.size
    await withProjects(async (projects) => {
      expect(await R.applyProjectRehomed({ event: { type: "project.updated", properties: {} }, scope: ServerScope.local, platform, projects })).toBe(undefined)
      expect(await R.applyProjectRehomed({ event: event({ to: 7 }), scope: ServerScope.local, platform, projects })).toBe(undefined)
      expect(projects.list().length).toBe(1)
    })
    expect(values.size).toBe(count)
  })
})

describe("AC-PROJe: the group is its own project entry (N8-366 part 2)", () => {
  test("label is the folder name (existing label rule, no root prefix) and the entry is distinct from the root", async () => {
    await withProjects(async (projects) => {
      await R.applyProjectRehomed({ event: event(), scope: ServerScope.local, platform, projects })
      const group = projects.list().find((p) => p.worktree === GROUP)
      expect(group !== undefined).toBe(true)
      expect(getFilename(group!.worktree)).toBe("Lumen")
      expect(projects.list().filter((p) => p.worktree === ROOT).length).toBe(1)
    })
  })
})
