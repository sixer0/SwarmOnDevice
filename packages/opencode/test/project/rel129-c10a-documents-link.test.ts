// 1.2.9 row 58 (AC-C10a, N9-139; spec 01c section 3.11; decisions C2(8), C7(d); S9-12).
//
// 1.2.8 row 68h refused a Default Project that is itself a link, but `realRoot` took realpath of the root's parent, so a
// linked Documents (`~/Documents` -> a folder elsewhere) passed the containment check and an approved move completed
// into the link target (S-33 probe H). Now the root's parent is looked at one level up as well: a linked parent (also a
// dangling one) and a parent swapped for a link after it was looked at are both refused REHOME_SYMLINK, dry run and
// real move alike, and nothing moves. The detail is "Documents" when that parent is named Documents, else the fixed
// "parent folder" (S9-12): never a path, never another segment. One level only: a link further up (macOS /var and
// /tmp, a linked home folder) keeps working (C7(d)).
//
// Rehome.make with fake ports (the decision port bound to this move, as row 54's INTENT in 68h), layouts from
// test/fixture/syn129-layouts.ts (N9-159) under a mkdtemp HOME (os.homedir stubbed); XDG is pinned by test/preload.ts.
// Run targeted: cd packages/opencode && bun test test/project/rel129-c10a-documents-link.test.ts

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Rehome } from "../../src/project/rehome"
import { documentsLinkLayout } from "../fixture/syn129-layouts"

const GROUP = "Lumen"
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const exists = (file: string) => fs.lstat(file).then(() => true, () => false)

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
const cleanups: (() => Promise<unknown>)[] = []
beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh129c10a-")))
  homeSpy = spyOn(os, "homedir").mockReturnValue(home)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
afterAll(async () => {
  homeSpy?.mockRestore()
  await fs.rm(home, { recursive: true, force: true })
})

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

async function layout(options?: Parameters<typeof documentsLinkLayout>[0]) {
  const built = await documentsLinkLayout({ parent: home, ...options })
  cleanups.push(built.cleanup)
  const data = path.join(built.root, "data")
  await fs.mkdir(path.join(data, "memory"), { recursive: true, mode: 0o700 })
  return { ...built, data }
}

const ports = (root: string, data: string): Rehome.Ports => ({
  root,
  dataDir: data,
  session: async () => undefined,
  projectId: async () => "global",
  moveSession: async () => {},
  terminals: async () => [],
  // The person's attested placement answer bound to this move (the mission into GROUP): a real move gets past the
  // decision check (row 54) and meets the check this file is about.
  decision: async () => ({
    status: "answered",
    topic: "project-placement",
    option: "join",
    by: "user",
    attested: true,
    group: GROUP,
    proposal: undefined,
  }),
})

const input = (root: string, mission: string, over: Partial<Rehome.Input> = {}): Rehome.Input => ({
  missionId: mission,
  from: root,
  to: path.join(root, GROUP),
  sessions: [],
  approvalRef: "D-1",
  approvalMission: mission,
  ...over,
})

const journal = (data: string) => fs.readdir(path.join(data, "rehome")).catch(() => [])

describe("AC-C10a: a linked parent of the Default Project never redirects a move", () => {
  test("a linked Documents: dry run and real move refused REHOME_SYMLINK \"Documents\", nothing moved, no journal", async () => {
    const at = await layout()
    const before = { case: await tree(at.case), elsewhere: await tree(at.elsewhere) }
    for (const dryRun of [true, false]) {
      const result = await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.defaultProject, at.mission, { dryRun }))
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Documents" })
    }
    expect({ case: await tree(at.case), elsewhere: await tree(at.elsewhere) }).toEqual(before)
    expect(await exists(path.join(at.realDefaultProject, GROUP, "docs", at.mission))).toBe(false)
    expect(await journal(at.data)).toEqual([])
  })

  test("S9-12: a linked parent not named Documents is refused with the fixed detail \"parent folder\"", async () => {
    const at = await layout({ parentName: "Synced Files" })
    const before = { case: await tree(at.case), elsewhere: await tree(at.elsewhere) }
    for (const dryRun of [true, false]) {
      const result = await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.defaultProject, at.mission, { dryRun }))
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "parent folder" })
    }
    expect({ case: await tree(at.case), elsewhere: await tree(at.elsewhere) }).toEqual(before)
    expect(await journal(at.data)).toEqual([])
  })

  test("a dangling Documents link is refused as a link, not as a missing folder", async () => {
    const at = await layout({ dangling: true })
    const before = await tree(at.root)
    for (const dryRun of [true, false]) {
      const result = await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.defaultProject, at.mission, { dryRun }))
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Documents" })
    }
    expect(await tree(at.root)).toEqual(before)
  })

  test("a Documents swapped for a link after it was looked at is refused by the one-level-up containment check", async () => {
    const at = await layout()
    // Start from a real Documents holding a real Default Project; the link target keeps its own Default Project.
    await fs.unlink(at.documents)
    await fs.mkdir(path.join(at.defaultProject, "docs", at.mission), { recursive: true })
    const elsewhereBefore = await tree(at.elsewhere)
    const original = fs.lstat.bind(fs)
    let swapped = false
    const spy = spyOn(fs, "lstat").mockImplementation((async (target: Parameters<typeof fs.lstat>[0]) => {
      const stat = await original(target)
      if (!swapped && target === at.documents) {
        swapped = true
        await fs.rm(at.documents, { recursive: true })
        await fs.symlink(at.target, at.documents, "dir")
      }
      return stat
    }) as typeof fs.lstat)
    try {
      const result = await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.defaultProject, at.mission))
      expect(swapped).toBe(true)
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Documents" })
    } finally {
      spy.mockRestore()
    }
    expect(await tree(at.elsewhere)).toEqual(elsewhereBefore)
    expect(await journal(at.data)).toEqual([])
  })

  test("one level only: a linked folder above Documents (as macOS /var, /tmp or a linked home) still moves", async () => {
    const at = await layout()
    // <root>/via -> <root>/case, so the root is given as <root>/via/<real Documents>/Default Project.
    await fs.unlink(at.documents)
    await fs.rename(at.target, at.documents)
    const via = path.join(at.root, "via")
    await fs.symlink(at.case, via, "dir")
    const root = path.join(via, "Documents", "Default Project")
    expect(await Rehome.make(ports(root, at.data)).run(input(root, at.mission, { dryRun: true }))).toMatchObject({
      planned: { folder: true },
    })
    expect(await Rehome.make(ports(root, at.data)).run(input(root, at.mission))).toMatchObject({ moved: { folder: true } })
    expect(await exists(path.join(at.case, "Documents", "Default Project", GROUP, "docs", at.mission, "report", "report.md"))).toBe(
      true,
    )
  })

  test("a real Documents folder keeps moving: dry run plans, the move lands in the group", async () => {
    const at = await layout()
    await fs.unlink(at.documents)
    await fs.rename(at.target, at.documents)
    expect(await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.defaultProject, at.mission, { dryRun: true }))).toMatchObject({
      planned: { folder: true },
    })
    expect(await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.defaultProject, at.mission))).toMatchObject({
      moved: { folder: true },
    })
    expect(await exists(path.join(at.defaultProject, GROUP, "docs", at.mission, "report", "report.md"))).toBe(true)
  })
})
