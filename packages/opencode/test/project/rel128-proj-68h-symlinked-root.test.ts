// 1.2.8 row 68h (security delta S-21, decision C184).
//
// A symlink planted at the Default Project path (or at a group the move uses) could redirect a person-approved move to
// a folder outside Documents: `realRoot` took realpath of the given path, so a link there (even a dangling one that a
// later folder fills) became the root. Now every root of a move is looked at with lstat when the person acts: a
// symlinked Default Project, a symlinked `from`, or a group that turns into a link before the folder is moved are all
// refused (REHOME_SYMLINK, detail = the last path segment only), and nothing moves. Real folders behave as before.
//
// Rehome.make with fake ports, a temp tree under a mkdtemp HOME (os.homedir stubbed); XDG is pinned by test/preload.ts.
// Run targeted: cd packages/opencode && bun test test/project/rel128-proj-68h-symlinked-root.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Rehome } from "../../src/project/rehome"

const MISSION = "2026-09-02_lumen-release-checklist"
const GROUP = "Lumen"
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const marker = (name: string) => JSON.stringify({ version: 1, name, kind: "product", created: 1787000000000 }) + "\n"

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh68h-")))
  homeSpy = spyOn(os, "homedir").mockReturnValue(home)
})
afterAll(async () => {
  homeSpy?.mockRestore()
  await fs.rm(home, { recursive: true, force: true })
})

type Session = { directory: string; projectID: string; busy: boolean }
let case_ = 0
let base = ""
let documents = ""
let R = ""
let elsewhere = ""
let data = ""
let sessions = new Map<string, Session>()
let onProjectId: ((directory: string) => Promise<void>) | undefined

beforeEach(async () => {
  case_ += 1
  base = path.join(home, `case-${case_}`)
  documents = path.join(base, "Documents")
  R = path.join(documents, "Default Project")
  elsewhere = path.join(base, "elsewhere")
  data = path.join(base, "data")
  await fs.mkdir(documents, { recursive: true })
  await fs.mkdir(path.join(data, "memory"), { recursive: true, mode: 0o700 })
  sessions = new Map()
  onProjectId = undefined
})

const ports = (root: string | undefined = R): Rehome.Ports => ({
  root,
  dataDir: data,
  session: async (id) => sessions.get(id),
  projectId: async (directory) => {
    await onProjectId?.(directory)
    return "global"
  },
  moveSession: async (id, directory) => {
    const current = sessions.get(id)
    if (current) sessions.set(id, { ...current, directory })
  },
  terminals: async () => [],
})

/** A Default Project as onboarding leaves it, at `dir`: one mission folder and one marked group. */
async function fill(dir: string) {
  await fs.mkdir(path.join(dir, "docs", MISSION, "report"), { recursive: true })
  await fs.writeFile(path.join(dir, "docs", MISSION, "report", "report.md"), "# Checklist\n\n- one\n")
  await fs.mkdir(path.join(dir, GROUP, ".swarm"), { recursive: true })
  await fs.writeFile(path.join(dir, GROUP, ".swarm", "group.json"), marker(GROUP))
}

/** Every entry under `dir` without following links: kind, relative path, file hash or link text. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (folder: string) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(folder, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isSymbolicLink()) out.push(`L ${rel} -> ${await fs.readlink(full)}`)
      else if (entry.isDirectory()) {
        out.push(`D ${rel}`)
        await walk(full)
      } else out.push(`F ${rel} ${sha(await fs.readFile(full))}`)
    }
  }
  await walk(dir)
  return out
}
const snapshot = async () => ({ tree: await tree(base) })

const input = (over: Partial<Rehome.Input> = {}): Rehome.Input => ({
  missionId: MISSION,
  from: R,
  to: path.join(R, GROUP),
  sessions: [],
  approvalRef: "D-1",
  approvalMission: MISSION,
  ...over,
})

describe("row 68h: a symlinked root never redirects a move (S-21)", () => {
  test("a Default Project that is a symlink to a folder outside Documents is refused, dry run and move, nothing moves", async () => {
    await fill(elsewhere)
    await fs.symlink(elsewhere, R)
    const before = await snapshot()
    for (const dryRun of [true, false]) {
      const result = await Rehome.make(ports()).run(input({ dryRun }))
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Default Project" })
    }
    expect(await snapshot()).toEqual(before)
    expect(await fs.readdir(path.join(data, "rehome")).catch(() => [])).toEqual([])
  })

  test("a dangling Default Project link is refused as a link, also after something fills its target", async () => {
    await fs.symlink(elsewhere, R)
    expect(await Rehome.make(ports()).run(input())).toEqual({ refused: "REHOME_SYMLINK", detail: "Default Project" })
    await fill(elsewhere)
    const before = await snapshot()
    expect(await Rehome.make(ports()).run(input())).toEqual({ refused: "REHOME_SYMLINK", detail: "Default Project" })
    expect(await snapshot()).toEqual(before)
    expect(await fs.stat(path.join(elsewhere, GROUP, "docs", MISSION)).then(() => true, () => false)).toBe(false)
  })

  test("a `from` that is a symlink to the Default Project is refused with its last segment only", async () => {
    await fill(R)
    const alias = path.join(documents, "Alias")
    await fs.symlink(R, alias)
    const before = await snapshot()
    const result = await Rehome.make(ports()).run(input({ from: alias }))
    expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Alias" })
    expect(await snapshot()).toEqual(before)
  })

  test("a group swapped for a link after preflight: the move is rolled back, nothing lands outside", async () => {
    await fill(R)
    await fs.mkdir(path.join(elsewhere, ".swarm"), { recursive: true })
    await fs.writeFile(path.join(elsewhere, ".swarm", "group.json"), marker(GROUP))
    const group = path.join(R, GROUP)
    // preflight asks the project of the existing group after it looked at it: swap the group for a link right then.
    onProjectId = async (directory) => {
      if (directory !== group) return
      onProjectId = undefined
      await fs.rm(group, { recursive: true })
      await fs.symlink(elsewhere, group)
    }
    const result = await Rehome.make(ports()).run(input())
    expect(result).toMatchObject({ refused: "REHOME_ROLLED_BACK", step: "folder" })
    expect(await fs.stat(path.join(R, "docs", MISSION, "report", "report.md")).then(() => true, () => false)).toBe(true)
    expect(await tree(elsewhere)).toEqual(["D .swarm", `F .swarm/group.json ${sha(marker(GROUP))}`])
  })

  test("real folders keep moving: dry run plans, the move lands in the group", async () => {
    await fill(R)
    expect(await Rehome.make(ports()).run(input({ dryRun: true }))).toMatchObject({ planned: { folder: true } })
    const result = await Rehome.make(ports()).run(input())
    expect(result).toMatchObject({ moved: { folder: true } })
    expect(await fs.stat(path.join(R, GROUP, "docs", MISSION, "report", "report.md")).then(() => true, () => false)).toBe(true)
  })
})
