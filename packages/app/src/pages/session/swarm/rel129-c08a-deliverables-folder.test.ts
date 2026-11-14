// Swarm 1.2.9 row 56, AC-C08a (N9-136; 01c §2 and §3.8). The deliverables of a mission are looked up in the
// mission's own project folder, chosen by `deliverablesDir` (N9-070): that folder only when it is the session's
// folder or one the app already has open (the Default Project root or one of its groups); otherwise no lookup at
// all. `docs/<m>/11_deliverables` is listed only when the `docs/<m>` listing holds a directory of that name, so a
// missing deliverables folder is never asked for again and again. Synthetic paths only (syn129).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as poll from "./mission-poll"
import { createMissionPoller, type MissionControlState, type MissionSource } from "./mission-poll"
import type { MissionGetWire } from "./mission-model"

const R = "/syn129/Default Project"
const G = `${R}/Golf`
const M = "2026-11-14_syn129-c08a"
const SES = ["ses_syn129c08a"]

type Entry = { name: string; type: "file" | "directory" }
const dir = (name: string): Entry => ({ name, type: "directory" })
const file = (name: string): Entry => ({ name, type: "file" })

const wire = (projectDir: string | undefined): MissionGetWire => ({
  mission: {
    id: M,
    title: "C08a",
    type: "document",
    status: "running",
    rows: [],
    ...(projectDir === undefined ? {} : { project: { dir: projectDir } }),
  },
  derived: { phases: [], waves: [], progress: { done: 0, total: 1 }, checkpoints: {} },
})

function source(projectDir: string | undefined, updatedAt = () => "t1"): MissionSource {
  return {
    list: async () => ({
      ok: true,
      data: {
        items: [
          {
            id: M,
            title: "C08a",
            type: "document",
            status: "running",
            progress: { done: 0, total: 1 },
            openRequests: [],
            updatedAt: updatedAt(),
          },
        ],
      },
    }),
    get: async () => ({ ok: true, data: wire(projectDir) }),
  }
}

/**
 * A fake of the server's `file.list`: entries keyed by absolute folder. A call without `directory` resolves against
 * the session's folder, as `sdk().client.file.list` does (the SDK's default directory). Every call is recorded.
 */
function disk(session: string, tree: Record<string, Entry[]>) {
  const calls: Array<{ path: string; directory: string | undefined }> = []
  const listFiles = async (path: string, directory?: string) => {
    calls.push({ path, directory })
    return tree[`${directory ?? session}/${path}`] ?? []
  }
  return { calls, listFiles }
}

async function settle(states: MissionControlState[], until: (s: MissionControlState | undefined) => boolean) {
  for (let i = 0; i < 40 && !until(states.at(-1)); i++) await new Promise((r) => setTimeout(r, 0))
}

function run(input: {
  session: string
  projectDir: string | undefined
  open: string[]
  tree: Record<string, Entry[]>
  updatedAt?: () => string
}) {
  const fs = disk(input.session, input.tree)
  const states: MissionControlState[] = []
  const poller = createMissionPoller({
    source: source(input.projectDir, input.updatedAt),
    directory: () => input.session,
    sessions: () => SES,
    lang: () => "en",
    listFiles: fs.listFiles,
    openFolders: () => input.open,
    onState: (s) => states.push(s),
  } as Parameters<typeof createMissionPoller>[0])
  return { fs, states, poller }
}

const titles = (s: MissionControlState | undefined) => (s?.mission?.deliverables ?? []).map((d) => d.title)

// The mission folder of a root mission: docs/<m> holds 11_deliverables, which holds x.md.
const rootTree: Record<string, Entry[]> = {
  [`${R}/docs/${M}`]: [file("notes-row.md"), dir("11_deliverables")],
  [`${R}/docs/${M}/11_deliverables`]: [file("x.md")],
}

describe("AC-C08a deliverables are looked up in the mission's folder (N9-136)", () => {
  test("root mission, session in a group: x.md is listed, both lookups go to the root folder", async () => {
    const { fs, states, poller } = run({ session: G, projectDir: R, open: [R, G], tree: rootTree })
    poller.setMode("live")
    await settle(states, (s) => !!s?.mission)
    poller.dispose()
    expect(titles(states.at(-1))).toContain("x.md")
    expect(fs.calls).toEqual([
      { path: `docs/${M}`, directory: R },
      { path: `docs/${M}/11_deliverables`, directory: R },
    ])
  })

  test("a mission folder that is neither the session's folder nor an open folder: 0 lookups", async () => {
    const outside = "/syn129/elsewhere"
    const tree = {
      [`${outside}/docs/${M}`]: [dir("11_deliverables")],
      [`${outside}/docs/${M}/11_deliverables`]: [file("x.md")],
    }
    const { fs, states, poller } = run({ session: G, projectDir: outside, open: [R, G], tree })
    poller.setMode("live")
    await settle(states, (s) => !!s?.mission)
    poller.dispose()
    expect(states.at(-1)?.mission?.id).toBe(M)
    expect(fs.calls.length).toBe(0)
    expect(titles(states.at(-1))).not.toContain("x.md")
  })

  test("docs/<m> without an 11_deliverables directory: that folder is never asked for, over repeated reads", async () => {
    let n = 0
    const tree = { [`${R}/docs/${M}`]: [file("11_deliverables"), file("plan.md")] } // a file of that name is not the folder
    const { fs, states, poller } = run({ session: R, projectDir: R, open: [R], tree, updatedAt: () => `t${n}` })
    poller.setMode("live")
    await settle(states, (s) => !!s?.mission)
    for (let i = 0; i < 3; i++) {
      n++
      poller.refresh()
      await settle(states, () => false)
    }
    poller.dispose()
    const deliverables = fs.calls.filter((c) => c.path.endsWith("/11_deliverables"))
    expect(deliverables.length).toBe(0)
    expect(fs.calls.filter((c) => c.path === `docs/${M}`).length).toBeGreaterThanOrEqual(2)
  })

  test("deliverablesDir: the directory rule (N9-070)", () => {
    const deliverablesDir = (poll as Record<string, unknown>).deliverablesDir as
      | ((input: { projectDir: string | undefined; session: string; open: readonly string[] }) => string | undefined)
      | undefined
    expect(typeof deliverablesDir).toBe("function")
    const f = deliverablesDir!
    expect(f({ projectDir: R, session: R, open: [] })).toBe(R)
    expect(f({ projectDir: `${R}/`, session: R, open: [] })).toBe(R) // one folder, two spellings
    expect(f({ projectDir: R, session: G, open: [R, G] })).toBe(R)
    expect(f({ projectDir: G, session: R, open: [R, G] })).toBe(G)
    expect(f({ projectDir: "/syn129/elsewhere", session: G, open: [R, G] })).toBeUndefined()
    expect(f({ projectDir: `${R}/../elsewhere`, session: G, open: [R, G] })).toBeUndefined()
    expect(f({ projectDir: "docs/relative", session: G, open: [R, G, "docs/relative"] })).toBeUndefined()
    // No project folder from an older host: the session's folder, as before 1.2.9.
    expect(f({ projectDir: undefined, session: G, open: [] })).toBe(G)
    expect(f({ projectDir: "", session: G, open: [] })).toBe(G)
  })

  test("the shown list keeps today's filter: files and .app bundles, no other folder", async () => {
    const tree = {
      [`${R}/docs/${M}`]: [dir("11_deliverables")],
      [`${R}/docs/${M}/11_deliverables`]: [file("x.md"), dir("Tool.app"), dir("drafts")],
    }
    const { states, poller } = run({ session: R, projectDir: R, open: [R], tree })
    poller.setMode("live")
    await settle(states, (s) => !!s?.mission)
    poller.dispose()
    const shown = titles(states.at(-1))
    expect(shown).toContain("x.md")
    expect(shown).toContain("Tool.app")
    expect(shown).not.toContain("drafts")
  })

  test("session.tsx passes the directory per call and the app's open folders", () => {
    const src = readFileSync(new URL("../../session.tsx", import.meta.url), "utf8")
    const block = src.slice(
      src.indexOf("const missionControl = createMissionControl("),
      src.indexOf("const missions: MissionControlMount"),
    )
    expect(block).toMatch(/file\.list\(\{ path, directory \}\)/)
    expect(block).toMatch(/openFolders:/)
    expect(block).toMatch(/layout\.projects\.list\(\)/)
  })
})
