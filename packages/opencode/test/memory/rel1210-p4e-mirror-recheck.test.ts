// 1.3.0 row 56, AC-P4e (N10-177): an exported note is re-checked at every mirror run. A note the person copied to the
// vault that has since turned secret-looking (Case A: the store file is rewritten on disk with the synthetic secret
// shape of N10-228, because secret text cannot enter through `update`, F12) or classified (Case B: an attested text
// edit carrying a classification word) is excluded by `mirrorExclusion` on the next run, so its vault copy (and for an
// index entry its mission note and report copy) is deleted. The export flag stays in the store (only Undo clears it),
// the hub counts the note as not copied, and every other file in the project folder is byte-identical (sha256 per
// file). No file in the folder carries the secret value or the classification word.
// Red at BASE a3e3c4c93a (precondition): the 1.2.9 mirror never copies a device-only note, so "copy present after
// sync 1" fails first.
// Store writes go through the Memory service of a temp instance or a direct rewrite of the store file; the mirror runs
// are explicit `VaultMirror.sync` calls on the store file as written, into a mkdtemp vault (SWARM_VAULT_DIR,
// os.homedir stubbed). Fixtures: row 40's synthetic stores (rel1210-p4/) and the 1.2.8 synthetic report. Never the
// real vault.
import { afterAll, beforeAll, describe, expect, spyOn } from "bun:test"
import crypto from "node:crypto"
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

// Synthetic values only: the secret shape of N10-228 (made-up value) and the classification words of N10-144.
const SECRET_VALUE = "plimbo-0000"
const SECRET_TEXT = `Plimbo reviews start from the zorvex list, password: ${SECRET_VALUE}`
const SECRET_BODY = `The second check logs in with password: ${SECRET_VALUE}`

let parent = ""
let vault = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
const savedEnv = { vault: process.env.SWARM_VAULT_DIR, off: process.env.SWARM_DISABLE_MEMORY }
beforeAll(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "p4e-")))
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

const writeStore = (target: string, raw: { version: number; enabled: boolean }, items: Item[]) =>
  Effect.promise(() =>
    fsp.writeFile(target, JSON.stringify({ version: raw.version, enabled: raw.enabled, items }, null, 2) + "\n", {
      mode: 0o600,
    }),
  )

/** Replaces the current instance's store with the fixture's items; returns the store file. */
const seed = (name: string, marker: string) =>
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
    yield* writeStore(target, raw, raw.items)
    return target
  })
const readStore = (target: string) => Effect.promise(async () => JSON.parse(await fsp.readFile(target, "utf8")) as Store)

/** Case A: the store file is rewritten on disk with one item changed (secret text cannot enter through `update`). */
const rewrite = (target: string, id: string, change: (item: Item) => Item) =>
  Effect.gen(function* () {
    const store = yield* readStore(target)
    yield* writeStore(
      target,
      { version: store.version ?? 2, enabled: store.enabled ?? true },
      store.items.map((entry) => (entry.id === id ? change(entry) : entry)),
    )
  })

// Attested calls carry a member the BASE interface does not declare; the cast keeps this file runnable at BASE.
type UpdateInput = Parameters<Memory.Interface["update"]>[1] & { personAttested?: boolean }
const attestedEdit = (id: string, text: string) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return yield* memory.update(id, { text, personAttested: true } as UpdateInput as Parameters<
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
/** sha256 and text of every file under the project folder, by relative path. */
type Snapshot = Map<string, { sha: string; text: string }>
const snapshot = (folder: string): Snapshot => {
  const out: Snapshot = new Map()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const bytes = fs.readFileSync(full)
        out.set(path.relative(folder, full), { sha: crypto.createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") })
      }
    }
  }
  walk(folder)
  return out
}
const allText = (folder: string) => [...snapshot(folder).values()].map((file) => file.text).join("\n")
const hub = (folder: string) => fs.readFileSync(path.join(folder, "index.md"), "utf8")

/**
 * The checks every case shares after sync 2: exactly `gone` deleted; only the hub and the `relinked` notes rewritten;
 * a relinked note (same session as the removed note, `## Related`) only loses its link line(s) to the removed note and
 * its body hash; every other file byte-identical (sha256); the flag still in the store; the class as expected; the hub
 * counts one more note not copied; the secret value or the classification word is in no file.
 */
const expectRecheck = (input: {
  folder: string
  target: string
  id: string
  gone: string[]
  relinked?: string[]
  before: Snapshot
  first: VaultMirror.SyncResult
  second: VaultMirror.SyncResult
  reason: "secret" | "classified"
  absent: string
}) =>
  Effect.gen(function* () {
    const relinked = input.relinked ?? []
    expect(input.second.status).toBe("ok")
    expect([...input.second.deleted].sort()).toEqual([...input.gone].sort())
    expect([...input.second.written].sort()).toEqual(["index.md", ...relinked].sort())
    const after = snapshot(input.folder)
    for (const rel of input.gone) expect(after.has(rel)).toBe(false)
    for (const [rel, file] of input.before) {
      if (rel === "index.md" || input.gone.includes(rel) || relinked.includes(rel)) continue
      expect({ rel, sha: after.get(rel)?.sha }).toEqual({ rel, sha: file.sha })
    }
    expect([...after.keys()].filter((rel) => !input.before.has(rel))).toEqual([])
    const goneNames = input.gone.map((rel) => path.basename(rel, ".md"))
    for (const rel of relinked) {
      const old = input.before.get(rel)!.text.split("\n")
      const now = after.get(rel)!.text.split("\n")
      // Nothing added except the new body hash; everything dropped is that hash, a link to a removed note, or the
      // `## Related` heading and its blank line when the section is left empty.
      expect(now.filter((line) => !old.includes(line) && !line.startsWith("swarm-hash: "))).toEqual([])
      const dropped = old.filter((line) => !now.includes(line))
      expect(dropped.some((line) => goneNames.some((name) => line.includes(name)))).toBe(true)
      expect(
        dropped.filter(
          (line) =>
            !line.startsWith("swarm-hash: ") &&
            !goneNames.some((name) => line.startsWith("- [[") && line.includes(name)) &&
            line !== "## Related" &&
            line !== "",
        ),
      ).toEqual([])
    }
    const stored = byId(yield* readStore(input.target), input.id)
    expect(stored.vaultAllowed).toBe(true)
    expect(stored.deviceOnly).toBe(true)
    expect(VaultMirror.mirrorExclusion(stored)).toBe(input.reason)
    expect(input.second.notCopied).toBe(input.first.notCopied + 1)
    expect(hub(input.folder)).toContain(`${input.second.notCopied} notes are not copied here`)
    expect(allText(input.folder)).not.toContain(input.absent)
  })

describe("AC-P4e: an exported note that turned secret or classified loses its vault copy on the next run", () => {
  it.live("Case A: text rewritten secret on disk; sync 2 deletes the copy, flag kept, others byte-identical (red at BASE)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4e-a-text")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const copy = noteFile(byId(raw, "p4e-001").text, "p4e-001")

        const first = yield* mirror(project, raw.key, target)
        expect(first.status).toBe("ok")
        expect(listing(folder)).toContain(copy)
        const before = snapshot(folder)

        yield* rewrite(target, "p4e-001", (item) => ({ ...item, text: SECRET_TEXT }))
        const second = yield* mirror(project, raw.key, target)
        yield* expectRecheck({ folder, target, id: "p4e-001", gone: [copy], before, first, second, reason: "secret", absent: SECRET_VALUE })
      }),
    ),
  )

  it.live("Case A: body rewritten secret on disk; the copy goes, the other exported notes stay", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4e-a-body")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const copy = noteFile(byId(raw, "p4e-002").text, "p4e-002")

        const first = yield* mirror(project, raw.key, target)
        expect(listing(folder)).toContain(copy)
        const before = snapshot(folder)

        yield* rewrite(target, "p4e-002", (item) => ({ ...item, body: SECRET_BODY }))
        const second = yield* mirror(project, raw.key, target)
        // p4e-002 shares its session with the exported index entry p4e-003: the mission note drops its link.
        yield* expectRecheck({
          folder,
          target,
          id: "p4e-002",
          gone: [copy],
          relinked: [missionFile(QUANDEL)],
          before,
          first,
          second,
          reason: "secret",
          absent: SECRET_VALUE,
        })
        expect(listing(folder)).toContain(noteFile(byId(raw, "p4e-001").text, "p4e-001"))
      }),
    ),
  )

  it.live("Case A: an exported index entry rewritten secret; its mission note and report copy go too", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4e-a-index")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const mission = missionFile(QUANDEL)
        const report = reportFile(QUANDEL)

        const first = yield* mirror(project, raw.key, target)
        expect(listing(folder)).toEqual(expect.arrayContaining([mission, report]))
        const before = snapshot(folder)

        yield* rewrite(target, "p4e-003", (item) => ({ ...item, body: SECRET_BODY }))
        const second = yield* mirror(project, raw.key, target)
        yield* expectRecheck({
          folder,
          target,
          id: "p4e-003",
          gone: [mission, report],
          // p4e-002 shares the session: its note drops the link to the removed mission note.
          relinked: [noteFile(byId(raw, "p4e-002").text, "p4e-002")],
          before,
          first,
          second,
          reason: "secret",
          absent: SECRET_VALUE,
        })
        expect(hub(folder)).not.toContain(path.basename(mission, ".md"))
        expect(hub(folder)).not.toContain(path.basename(report, ".md"))
      }),
    ),
  )

  it.live("Case B: attested edit carrying RESTRICTED; flag kept by the store, sync 2 deletes the copy (red at BASE)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4e-b-text")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const copy = noteFile(byId(raw, "p4e-001").text, "p4e-001")

        const first = yield* mirror(project, raw.key, target)
        expect(first.status).toBe("ok")
        expect(listing(folder)).toContain(copy)
        const before = snapshot(folder)

        const edited = yield* attestedEdit("p4e-001", "Plimbo reviews always start from the zorvex list, marked RESTRICTED.")
        expect(edited.refused).toBeUndefined()
        expect(edited.item?.vaultAllowed).toBe(true)
        const second = yield* mirror(project, raw.key, target)
        yield* expectRecheck({ folder, target, id: "p4e-001", gone: [copy], before, first, second, reason: "classified", absent: "RESTRICTED" })
      }),
    ),
  )

  it.live("Case B: the classification word is matched whole and in any case (Confidential)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const raw = fixture("exported.json")
        const target = yield* seed("exported.json", "anchor-p4e-b-case")
        const project = newProject()
        const folder = folderOf(project, raw.key)
        const copy = noteFile(byId(raw, "p4e-002").text, "p4e-002")

        const first = yield* mirror(project, raw.key, target)
        expect(listing(folder)).toContain(copy)
        const before = snapshot(folder)

        const edited = yield* attestedEdit("p4e-002", "Nimbard grids are Confidential and checked twice before the vestrel run.")
        expect(edited.refused).toBeUndefined()
        const second = yield* mirror(project, raw.key, target)
        yield* expectRecheck({
          folder,
          target,
          id: "p4e-002",
          gone: [copy],
          relinked: [missionFile(QUANDEL)],
          before,
          first,
          second,
          reason: "classified",
          absent: "Confidential",
        })
      }),
    ),
  )
})
