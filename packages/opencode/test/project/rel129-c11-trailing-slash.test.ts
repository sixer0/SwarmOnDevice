// 1.2.9 row 58b (AC-C11, N9-141; spec 01c section 3.12; 1.2.8 security finding S-31, probe J).
//
// 1.2.8 row 68h refused a move whose source folder (`from`) is a symbolic link, but `notLinked` ran `lstat` on the
// path as given. With a trailing "/" (`Documents/Alias/`, Alias a link to the Default Project) `lstat` follows the
// link, so the check passed and a dry run planned the move (S-31 probe J1). Now `notLinked` looks at
// `path.resolve(folder)`, which drops the trailing separator: the check and its detail name the same string, and the
// link is refused `REHOME_SYMLINK "Alias"`, dry run and real move alike, with nothing moved and no journal.
// J2 (`Outside/`, a link to a marked folder outside R) is refused and nothing moves on either side; J3 (root env
// `LinkRoot/`) keeps `REHOME_SYMLINK "LinkRoot"`; compensation keeps refusing a trailing separator in `childOfRoot`.
//
// Rehome.make with fake ports (the decision port bound to this move, as rows 54 and 58), layout from
// test/fixture/syn129-layouts.ts (N9-160) under a mkdtemp HOME (os.homedir stubbed); XDG is pinned by test/preload.ts.
// Run targeted: cd packages/opencode && bun test test/project/rel129-c11-trailing-slash.test.ts

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Rehome } from "../../src/project/rehome"
import { trailingSlashLinkLayout } from "../fixture/syn129-layouts"

const GROUP = "Lumen"
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
const cleanups: (() => Promise<unknown>)[] = []
beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh129c11-")))
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

async function layout() {
  const built = await trailingSlashLinkLayout({ parent: home })
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

const input = (from: string, to: string, mission: string, over: Partial<Rehome.Input> = {}): Rehome.Input => ({
  missionId: mission,
  from,
  to,
  sessions: [],
  approvalRef: "D-1",
  approvalMission: mission,
  ...over,
})

const journal = (data: string) => fs.readdir(path.join(data, "rehome")).catch(() => [])
/** Everything the layout holds outside the scratch data dir: R, the links in Documents, the outside folder. */
const snapshot = async (at: Awaited<ReturnType<typeof layout>>) => ({
  documents: await tree(at.documents),
  outside: await tree(at.outside),
})

describe("AC-C11: a trailing '/' on the source folder never gets a link past the rehome symlink check", () => {
  test("J1: from = Documents/Alias/ (a link to R) is refused REHOME_SYMLINK \"Alias\", dry run and real move, nothing moved", async () => {
    const at = await layout()
    expect(at.from.endsWith(path.sep)).toBe(true)
    const before = await snapshot(at)
    const to = path.join(at.defaultProject, GROUP)
    for (const dryRun of [true, false]) {
      const result = await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.from, to, at.mission, { dryRun }))
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Alias" })
    }
    expect(await snapshot(at)).toEqual(before)
    expect(await fs.lstat(path.join(at.missionDir!, "report", "report.md")).then(() => true)).toBe(true)
    expect(await journal(at.data)).toEqual([])
  })

  test("J1 without the trailing '/' (1.2.8 probe F1) gives the same refusal", async () => {
    const at = await layout()
    const to = path.join(at.defaultProject, GROUP)
    const result = await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.alias, to, at.mission, { dryRun: true }))
    expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Alias" })
  })

  test("J2: from = Documents/Outside/ (a link to a marked folder outside R) is refused, dry run and real move, nothing moved", async () => {
    const at = await layout()
    const before = await snapshot(at)
    const to = path.join(at.defaultProject, GROUP)
    for (const dryRun of [true, false]) {
      const result = await Rehome.make(ports(at.defaultProject, at.data)).run(input(at.outsideFrom, to, at.mission, { dryRun }))
      // The same verdict as the same link given without the trailing "/" (next test): the source is a link.
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Outside" })
    }
    expect(await snapshot(at)).toEqual(before)
    expect(await journal(at.data)).toEqual([])
  })

  test("J2 without the trailing '/' gives the same refusal", async () => {
    const at = await layout()
    const to = path.join(at.defaultProject, GROUP)
    const result = await Rehome.make(ports(at.defaultProject, at.data)).run(
      input(at.outsideAlias, to, at.mission, { dryRun: true }),
    )
    expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "Outside" })
  })

  test("J3: root env Documents/LinkRoot/ stays REHOME_SYMLINK \"LinkRoot\", nothing moved", async () => {
    const at = await layout()
    const before = await snapshot(at)
    for (const dryRun of [true, false]) {
      const result = await Rehome.make(ports(at.linkRootEnv, at.data)).run(
        input(at.linkRootEnv, path.join(at.linkRoot, GROUP), at.mission, { dryRun }),
      )
      expect(result).toEqual({ refused: "REHOME_SYMLINK", detail: "LinkRoot" })
    }
    expect(await snapshot(at)).toEqual(before)
    expect(await journal(at.data)).toEqual([])
  })

  test("compensation still refuses a group given with a trailing separator (childOfRoot)", async () => {
    const at = await layout()
    const result = await Rehome.make(ports(at.defaultProject, at.data)).run(
      input(at.groupDir! + path.sep, at.defaultProject, at.mission, { compensates: "syn129-journal" }),
    )
    expect(result).toEqual({ refused: "REHOME_OUTSIDE_ROOT", detail: "not a normalised absolute path" })
  })

  test("the real Default Project given with a trailing '/' still plans and moves", async () => {
    const at = await layout()
    const from = at.defaultProject + path.sep
    const to = path.join(at.defaultProject, GROUP)
    expect(await Rehome.make(ports(at.defaultProject, at.data)).run(input(from, to, at.mission, { dryRun: true }))).toMatchObject({
      planned: { folder: true },
    })
    expect(await Rehome.make(ports(at.defaultProject, at.data)).run(input(from, to, at.mission))).toMatchObject({
      moved: { folder: true },
    })
    expect(await fs.lstat(path.join(to, "docs", at.mission, "report", "report.md")).then(() => true)).toBe(true)
  })
})
