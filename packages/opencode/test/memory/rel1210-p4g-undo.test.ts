// 1.2.10 row 55, AC-P4g (N10-181): Undo of an export. `update(id, { vaultAllowed: false, personAttested: true })`
// deletes the export keys (the note stays device-only, every other item byte-identical), and the next mirror run deletes
// the vault copy, which the hub then counts as not copied. Folded S10-10(P4): for an exported index entry the run also
// deletes its mission note and its report copy and the hub no longer links them; for an exported roll-up its mission
// notes go too. Undo of a note that has since turned secret or classified succeeds; a copy the person edited (no longer
// owned) is left alone while the flag is still cleared (R-6).
// Red at BASE a3e3c4c93a (precondition): the 1.2.9 mirror never copies a device-only note, so "copy present after
// sync 1" fails first.
// Store writes go through the Memory service of a temp instance; the mirror runs are explicit `VaultMirror.sync` calls on
// the store file as written, into a mkdtemp vault (SWARM_VAULT_DIR, os.homedir stubbed). Fixtures: row 40's synthetic
// stores (rel1210-p4/) and the 1.2.8 synthetic report. Never the real vault.
import { afterAll, beforeAll, describe, expect, spyOn } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Vault } from "@opencode-ai/core/vault"
import { Memory } from "../../src/memory/memory"
import { VaultMirror } from "../../src/memory/vault-mirror"
import { Provider } from "../../src/provider/provider"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const P4 = path.join(import.meta.dir, "fixtures", "rel1210-p4")
const reportBytes = fs.readFileSync(path.join(import.meta.dir, "fixtures", "rel128-obs-c", "report.md"))
type Item = Memory.Item
type Fixture = { key: string; projectName: string; version: number; enabled: boolean; items: Item[] }
type Store = { version?: number; enabled?: boolean; items: Item[] }
const fixture = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(P4, name), "utf8"))
const byId = (store: { items: Item[] }, id: string) => store.items.find((entry) => entry.id === id)!

const QUANDEL = "2026-10-02_quandel-review"
const REPORT = `docs/${QUANDEL}/report/report.md`
const noteFile = (text: string, id: string) => `notes/${VaultMirror.noteName("note", id, text)}`
const missionFile = (id: string) => `missions/${VaultMirror.noteName("mission", id)}`
const reportFile = (id: string) => `reports/${VaultMirror.noteName("report", id)}`

let parent = ""
let vault = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
const savedEnv = { vault: process.env.SWARM_VAULT_DIR, off: process.env.SWARM_DISABLE_MEMORY }
beforeAll(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "p4g-")))
  vault = path.join(parent, "vault")
  fs.mkdirSync(vault)
  fs.mkdirSync(path.join(parent, "home"))
  homeSpy = spyOn(os, "homedir").mockReturnValue(path.join(parent, "home"))
  process.env.SWARM_VAULT_DIR = vault
  delete process.env.SWARM_DISABLE_MEMORY
})
afterAll(() => {
  homeSpy?.mockRestore()
  if (savedEnv.vault === undefined) delete process.env.SWARM_VAULT_DIR
  else process.env.SWARM_VAULT_DIR = savedEnv.vault
  if (savedEnv.off !== undefined) process.env.SWARM_DISABLE_MEMORY = savedEnv.off
  fs.rmSync(parent, { recursive: true, force: true })
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Memory.node, CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]),
    [
      [
        Provider.node,
        Layer.succeed(
          Provider.Service,
          Provider.Service.of({ getProvider: () => Effect.succeed({ options: {} }) } as unknown as Provider.Interface),
        ),
      ],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
)

/** Replaces the current instance's store with the fixture's items; returns the store file. */
const seed = (name: string, marker: string, edit: (items: Item[]) => Item[] = (items) => items) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    yield* memory.add({ text: marker, source: "user" })
    const dir = path.join(Global.Path.data, "memory")
    const target = yield* Effect.promise(async () => {
      for (const file of await fsp.readdir(dir)) {
        const full = path.join(dir, file)
        if (file.endsWith(".json") && (await fsp.readFile(full, "utf8")).includes(marker)) return full
      }
      throw new Error("store not found")
    })
    const raw = fixture(name)
    yield* Effect.promise(() =>
      fsp.writeFile(target, JSON.stringify({ version: raw.version, enabled: raw.enabled, items: edit(raw.items) }, null, 2) + "\n", {
        mode: 0o600,
      }),
    )
    return target
  })
const readStore = (target: string) => Effect.promise(async () => JSON.parse(await fsp.readFile(target, "utf8")) as Store)

// Attested calls carry members the BASE interface does not declare; the cast keeps this file runnable at BASE.
type UpdateInput = Parameters<Memory.Interface["update"]>[1] & { vaultAllowed?: boolean; personAttested?: boolean }
const undo = (id: string) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return yield* memory.update(id, { vaultAllowed: false, personAttested: true } as UpdateInput as Parameters<
      Memory.Interface["update"]
    >[1])
  })

/** A project folder of its own per case, with the confirmed report in place. */
let projectCount = 0
const newProject = () => {
  const project = path.join(parent, `project-${++projectCount}`)
  fs.mkdirSync(path.join(project, path.dirname(REPORT)), { recursive: true })
  fs.writeFileSync(path.join(project, REPORT), reportBytes)
  return project
}
const mirror = (project: string, key: string, target: string) =>
  readStore(target).pipe(
    Effect.flatMap((store) =>
      Effect.promise(() =>
        VaultMirror.sync({ key, directory: project, projectRoot: project, projectName: "Syn Project P4", language: "en", items: store.items }),
      ),
    ),
  )
const folderOf = (project: string, key: string) => path.join(vault, "swarm-memory", Vault.vaultProjectFolder(project, key))
const listing = (folder: string) => {
  const out: string[] = []
  for (const sub of ["notes", "missions", "reports", "skills"]) {
    const dir = path.join(folder, sub)
    if (fs.existsSync(dir)) out.push(...fs.readdirSync(dir).map((name) => `${sub}/${name}`))
  }
  return out.sort()
}
const hub = (folder: string) => fs.readFileSync(path.join(folder, "index.md"), "utf8")
/** JSON with sorted keys: the store writes keys in schema order, the fixtures in their own order. */
const canon = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  )
const keyless = (item: Item) => !("vaultAllowed" in item) && !("vaultReportSha256" in item)

describe("AC-P4g: Undo clears the export and the next run deletes the copy", () => {
  it.live("note: key gone, still device-only, others byte-identical; sync 2 deletes the copy and counts it (red at BASE)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4g-note")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const copy = noteFile(byId(raw, "p4e-001").text, "p4e-001")

        const first = yield* mirror(project, raw.key, target)
        expect(first.status).toBe("ok")
        expect(listing(folder)).toContain(copy)

        const before = yield* readStore(target)
        const result = yield* undo("p4e-001")
        expect(result.item).toBeDefined()
        expect(keyless(result.item!)).toBe(true)
        const after = yield* readStore(target)
        const note = byId(after, "p4e-001")
        expect(keyless(note)).toBe(true)
        expect(note.deviceOnly).toBe(true)
        expect(note.text).toBe(byId(before, "p4e-001").text)
        for (const entry of before.items) {
          if (entry.id === "p4e-001") continue
          expect(canon(byId(after, entry.id))).toBe(canon(entry))
        }

        const second = yield* mirror(project, raw.key, target)
        expect(second.status).toBe("ok")
        expect(second.deleted).toEqual([copy])
        expect(second.written).toEqual(["index.md"])
        expect(listing(folder)).not.toContain(copy)
        expect(second.notCopied).toBe(first.notCopied + 1)
        expect(hub(folder)).toContain(`${second.notCopied} notes are not copied here`)
      }),
    ),
  )

  it.live("S10-10 index entry: its mission note and report copy are deleted and the hub links neither", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4g-index")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const mission = missionFile(QUANDEL)
        const report = reportFile(QUANDEL)

        yield* mirror(project, raw.key, target)
        expect(listing(folder)).toEqual(expect.arrayContaining([mission, report]))
        expect(hub(folder)).toContain(path.basename(mission, ".md"))
        expect(hub(folder)).toContain(path.basename(report, ".md"))

        expect(keyless((yield* undo("p4e-003")).item!)).toBe(true)
        expect(keyless(byId(yield* readStore(target), "p4e-003"))).toBe(true)
        const second = yield* mirror(project, raw.key, target)
        expect([...second.deleted].sort()).toEqual([mission, report].sort())
        expect(listing(folder)).not.toContain(mission)
        expect(listing(folder)).not.toContain(report)
        expect(hub(folder)).not.toContain(path.basename(mission, ".md"))
        expect(hub(folder)).not.toContain(path.basename(report, ".md"))
        // The other exported notes stay.
        expect(listing(folder)).toContain(noteFile(byId(raw, "p4e-001").text, "p4e-001"))
      }),
    ),
  )

  it.live("S10-10 roll-up: the roll-up note and its mission notes are deleted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("mixed-rollup.json")
        const target = yield* seed("mixed-rollup.json", "anchor-p4g-rollup", (items) =>
          items.filter((entry) => entry.id === "p4r-r01" || entry.id === "p4r-m01"),
        )
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const rollup = noteFile(byId(raw, "p4r-r01").text, "p4r-r01")
        const mission = missionFile("2026-07-03_vestrel-pass")

        yield* mirror(project, raw.key, target)
        expect(listing(folder)).toEqual([mission, rollup].sort())

        expect(keyless((yield* undo("p4r-r01")).item!)).toBe(true)
        const second = yield* mirror(project, raw.key, target)
        expect([...second.deleted].sort()).toEqual([mission, rollup].sort())
        expect(listing(folder)).toEqual([])
        expect(hub(folder)).not.toContain(path.basename(mission, ".md"))
      }),
    ),
  )

  it.live("a note that turned classified or secret since the export can still be undone", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const target = yield* seed("exported.json", "anchor-p4g-turned", (items) =>
          items.map((entry) =>
            entry.id === "p4e-001"
              ? { ...entry, text: "Plimbo reviews start from the zorvex list, marked RESTRICTED." }
              : entry.id === "p4e-002"
                ? { ...entry, text: "Nimbard staging login, password: plimbo-0000" }
                : entry,
          ),
        )
        for (const id of ["p4e-001", "p4e-002"]) {
          const result = yield* undo(id)
          expect(result.refused).toBeUndefined()
          expect(keyless(result.item!)).toBe(true)
          const stored = byId(yield* readStore(target), id)
          expect(keyless(stored)).toBe(true)
          expect(stored.deviceOnly).toBe(true)
        }
      }),
    ),
  )

  it.live("R-6: a copy the person edited is left as it is; the flag is cleared all the same", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4g-edited")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const copy = noteFile(byId(raw, "p4e-001").text, "p4e-001")

        yield* mirror(project, raw.key, target)
        const file = path.join(folder, copy)
        fs.appendFileSync(file, "\nMy own plimbo line.\n")
        const edited = fs.readFileSync(file)

        expect(keyless((yield* undo("p4e-001")).item!)).toBe(true)
        expect(keyless(byId(yield* readStore(target), "p4e-001"))).toBe(true)
        const second = yield* mirror(project, raw.key, target)
        expect(second.deleted).not.toContain(copy)
        expect(fs.readFileSync(file).equals(edited)).toBe(true)
      }),
    ),
  )
})
