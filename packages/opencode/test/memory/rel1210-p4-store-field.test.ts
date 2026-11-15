// 1.2.10 row 53, AC-P4-store (N10-174): the memory store persists and clears the vault export fields `vaultAllowed`
// (N10-061) and `vaultReportSha256` (N10-074) under the person's attestation (`personAttested`, N10-069), one case per
// site S-1..S-9 of 01d §3.5, with the folded findings S10-07, S10-13, S10-18 (01_specs §4) and the OR-only deviceOnly
// pins of S10-04. Red at BASE a3e3c4c93a: `update` ignores `personAttested` and every write drops `vaultAllowed`, so
// "the flag is kept after an attested edit" fails. Sub-case U-1 (describe "U-1") is green at BASE by design: a 1.2.10
// store decodes under the BASE `ProjectMemory.Item` (01d §5, the Undo evidence) and is ledgered CHAR.
// Fixtures: row 40's synthetic stores (N10-227..N10-233), never a real store.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import { Memory } from "../../src/memory/memory"
import { Provider } from "../../src/provider/provider"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES = path.join(import.meta.dir, "fixtures/rel1210-p4")
const SRC = path.join(import.meta.dir, "../../src")

// HOME is a fresh temp folder for this file: nothing here may reach a real memory store or vault.
let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "m53-"))
  homeSpy = spyOn(os, "homedir").mockReturnValue(home)
})
afterAll(async () => {
  homeSpy?.mockRestore()
  await fs.rm(home, { recursive: true, force: true })
})

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({ getProvider: () => Effect.succeed({ options: {} }) } as unknown as Provider.Interface),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Memory.node, CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]),
    [
      [Provider.node, providerLayer],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

type Item = Memory.Item
type Store = { version?: number; enabled?: boolean; items: Item[]; consolidated?: unknown }

const fixture = (name: string): Store => JSON.parse(require("node:fs").readFileSync(path.join(FIXTURES, name), "utf8"))
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

/** The store file of the current instance, found by a note only it holds. */
const storeFile = (marker: string) =>
  Effect.promise(async () => {
    const dir = path.join(Global.Path.data, "memory")
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".json")) continue
      const target = path.join(dir, name)
      if ((await fs.readFile(target, "utf8")).includes(marker)) return target
    }
    throw new Error("store not found")
  })

/** Replaces the instance's store with a fixture store (only its store keys; the fixture's comment keys are dropped). */
const seed = (name: string, marker: string) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    yield* memory.add({ text: marker, source: "user" })
    const target = yield* storeFile(marker)
    const raw = fixture(name)
    const store = {
      version: raw.version,
      enabled: raw.enabled,
      items: raw.items,
      ...(raw.consolidated ? { consolidated: raw.consolidated } : {}),
    }
    yield* Effect.promise(() => fs.writeFile(target, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 }))
    return target
  })

const readStore = (target: string) => Effect.promise(async () => JSON.parse(await fs.readFile(target, "utf8")) as Store)
const fileSha = (target: string) => Effect.promise(async () => sha256(await fs.readFile(target)))
const byId = (store: Store, id: string) => store.items.find((item) => item.id === id)!
/** JSON with sorted keys: the store writes keys in schema order, the fixtures in their own order. */
const canon = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  )
/** Every item other than `except` is unchanged (every key and value) between the two stores. */
const othersEqual = (before: Store, after: Store, except: string[]) => {
  for (const item of before.items) {
    if (except.includes(item.id)) continue
    expect(canon(byId(after, item.id))).toBe(canon(item))
  }
}
/** The items as this build's store decoder reads them (decodeStore's shape, no options). */
const decodeItems = (items: unknown) => {
  const parsed = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(ProjectMemory.Item) }))({ items })
  return parsed.items as readonly Item[]
}

// Attested calls carry members BASE does not declare; the cast keeps this file runnable at BASE (red, not a type error).
type UpdateInput = Parameters<Memory.Interface["update"]>[1] & { vaultAllowed?: boolean; personAttested?: boolean }
const update = (memory: Memory.Interface, id: string, input: UpdateInput) =>
  memory.update(id, input as Parameters<Memory.Interface["update"]>[1])

const QUANDEL = "2026-10-02_quandel-review"
const quandelLine = (outcome: string, report = `docs/${QUANDEL}/report/report.md`) =>
  `2026-10-02 ${QUANDEL} | ${outcome} | triggers: quandel, nimbard | ${report}`

describe("AC-P4-store S-3: text edits keep the export only when the person attests them", () => {
  it.live("an attested edit of an exported note keeps vaultAllowed (red at BASE)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-headline")
        const before = yield* readStore(target)
        const result = yield* update(memory, "p4e-001", {
          text: "Plimbo reviews always start from the zorvex list, then the vestrel list.",
          personAttested: true,
        })
        expect(result.item?.vaultAllowed).toBe(true)
        const after = yield* readStore(target)
        expect(byId(after, "p4e-001")).toMatchObject({ vaultAllowed: true, deviceOnly: true, source: "user" })
        othersEqual(before, after, ["p4e-001"])
      }),
    ),
  )

  it.live("an unattested edit clears the flag in the same write", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-unattested")
        const result = yield* update(memory, "p4e-002", { text: "Nimbard grids are checked three times." })
        expect(result.item).toBeDefined()
        expect("vaultAllowed" in result.item!).toBe(false)
        const stored = byId(yield* readStore(target), "p4e-002")
        expect("vaultAllowed" in stored).toBe(false)
        expect(stored.deviceOnly).toBe(true)
      }),
    ),
  )

  it.live("index entry: attested edit, same report keeps both keys; S10-07 another report clears both", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-index")
        const sha = byId(yield* readStore(target), "p4e-003").vaultReportSha256
        expect(sha).toMatch(/^[0-9a-f]{64}$/)

        const same = yield* update(memory, "p4e-003", { text: quandelLine("quandel review closed again"), personAttested: true })
        expect(same.item).toMatchObject({ vaultAllowed: true, vaultReportSha256: sha, deviceOnly: true })
        expect(byId(yield* readStore(target), "p4e-003")).toMatchObject({ vaultAllowed: true, vaultReportSha256: sha })

        const moved = yield* update(memory, "p4e-003", {
          text: quandelLine("quandel review closed again", `docs/${QUANDEL}/report/report-v2.md`),
          personAttested: true,
        })
        expect(moved.item).toBeDefined()
        const stored = byId(yield* readStore(target), "p4e-003")
        expect("vaultAllowed" in stored).toBe(false)
        expect("vaultReportSha256" in stored).toBe(false)
        expect(stored.deviceOnly).toBe(true)
      }),
    ),
  )

  it.live("index entry: an unattested text change clears both keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-index-unattested")
        const result = yield* update(memory, "p4e-003", { text: quandelLine("quandel review closed by an agent") })
        expect(result.item).toBeDefined()
        const stored = byId(yield* readStore(target), "p4e-003")
        expect("vaultAllowed" in stored).toBe(false)
        expect("vaultReportSha256" in stored).toBe(false)
      }),
    ),
  )
})

describe("AC-P4-store S-4: a scope change clears the flag (D-8, I-1)", () => {
  it.live("true -> true is no change and keeps it; an attested true -> false clears it", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-scope")
        const same = yield* update(memory, "p4e-001", { deviceOnly: true, personAttested: true })
        expect(same.item).toMatchObject({ deviceOnly: true, vaultAllowed: true })
        expect(byId(yield* readStore(target), "p4e-001").vaultAllowed).toBe(true)

        const flipped = yield* update(memory, "p4e-003", { deviceOnly: false, personAttested: true })
        expect(flipped.item?.deviceOnly).toBe(false)
        const stored = byId(yield* readStore(target), "p4e-003")
        expect(stored.deviceOnly).toBe(false)
        expect("vaultAllowed" in stored).toBe(false)
        expect("vaultReportSha256" in stored).toBe(false)
      }),
    ),
  )
})

describe("AC-P4-store S-5: setting and clearing the flag (01d §3.3 step 2)", () => {
  it.live("unattested: nothing changes and {} is returned (store-level guard)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-guard")
        const before = yield* fileSha(target)
        expect(yield* update(memory, "p4e-005", { vaultAllowed: true })).toEqual({})
        expect(yield* update(memory, "p4e-005", { vaultAllowed: true, personAttested: false })).toEqual({})
        expect(yield* update(memory, "p4e-001", { vaultAllowed: false })).toEqual({})
        expect(yield* fileSha(target)).toBe(before)
      }),
    ),
  )

  it.live("attested allowed:true stores true once; a second call writes nothing; undo deletes the key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-set")
        const before = yield* readStore(target)
        const set = yield* update(memory, "p4e-005", { vaultAllowed: true, personAttested: true })
        expect(set.item).toMatchObject({ id: "p4e-005", vaultAllowed: true, deviceOnly: true })
        expect("vaultReportSha256" in set.item!).toBe(false)
        const after = yield* readStore(target)
        expect(byId(after, "p4e-005").vaultAllowed).toBe(true)
        othersEqual(before, after, ["p4e-005"])

        const sha = yield* fileSha(target)
        expect((yield* update(memory, "p4e-005", { vaultAllowed: true, personAttested: true })).item?.vaultAllowed).toBe(true)
        expect(yield* fileSha(target)).toBe(sha)

        const undone = yield* update(memory, "p4e-005", { vaultAllowed: false, personAttested: true })
        expect("vaultAllowed" in undone.item!).toBe(false)
        const raw = yield* Effect.promise(() => fs.readFile(target, "utf8"))
        expect(raw).not.toContain('"vaultAllowed": false')
        const last = JSON.parse(raw) as Store
        expect(canon(byId(last, "p4e-005"))).toBe(canon(byId(before, "p4e-005")))
        // Undo of a note without the key: no write.
        const unchanged = yield* fileSha(target)
        expect((yield* update(memory, "p4e-005", { vaultAllowed: false, personAttested: true })).item).toBeDefined()
        expect(yield* fileSha(target)).toBe(unchanged)
      }),
    ),
  )

  it.live("undo of an exported index entry removes the flag and the report hash; the note stays device-only", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-undo")
        const before = yield* readStore(target)
        yield* update(memory, "p4e-003", { vaultAllowed: false, personAttested: true })
        const after = yield* readStore(target)
        const stored = byId(after, "p4e-003")
        expect("vaultAllowed" in stored).toBe(false)
        expect("vaultReportSha256" in stored).toBe(false)
        expect(stored.deviceOnly).toBe(true)
        othersEqual(before, after, ["p4e-003"])
      }),
    ),
  )

  it.live("an index entry export stores the sha256 of its report, read under the project root (S10-01 contribution)", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-sha")
        // p4e-004 without a report file: exported, no hash (the mirror links it only).
        const bare = yield* update(memory, "p4e-004", { vaultAllowed: true, personAttested: true })
        expect(bare.item?.vaultAllowed).toBe(true)
        expect("vaultReportSha256" in bare.item!).toBe(false)
        yield* update(memory, "p4e-004", { vaultAllowed: false, personAttested: true })

        const bytes = "Synthetic vestrel audit report.\nZorvex rows checked.\n"
        const report = path.join(dir, "docs/2026-10-05_vestrel-audit/report/report.md")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(report), { recursive: true })
          await fs.writeFile(report, bytes)
        })
        const set = yield* update(memory, "p4e-004", { vaultAllowed: true, personAttested: true })
        expect(set.item).toMatchObject({ vaultAllowed: true, vaultReportSha256: sha256(bytes) })
        expect(byId(yield* readStore(target), "p4e-004").vaultReportSha256).toBe(sha256(bytes))

        // A report that is a symlink is never followed: no hash.
        yield* update(memory, "p4e-004", { vaultAllowed: false, personAttested: true })
        yield* Effect.promise(async () => {
          const real = path.join(dir, "elsewhere.md")
          await fs.writeFile(real, bytes)
          await fs.rm(report)
          await fs.symlink(real, report)
        })
        const linked = yield* update(memory, "p4e-004", { vaultAllowed: true, personAttested: true })
        expect(linked.item?.vaultAllowed).toBe(true)
        expect("vaultReportSha256" in linked.item!).toBe(false)
      }),
    ),
  )

  it.live("refusals in order: archived > classified > secret > not_device_only; each leaves the file unchanged", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const cases: [string, string, string, Memory.Result["refused"]][] = [
          ["exported.json", "anchor-p4s-r1", "p4e-006", "not_device_only"],
          ["mixed-rollup.json", "anchor-p4s-r2", "p4r-m01", "archived"],
          ["classified.json", "anchor-p4s-r3", "p4c-001", "classified"],
          ["secret-looking.json", "anchor-p4s-r4", "p4s-001", "secret"],
        ]
        for (const [name, marker, id, refused] of cases) {
          const target = yield* seed(name, marker)
          const before = yield* fileSha(target)
          expect(yield* update(memory, id, { vaultAllowed: true, personAttested: true })).toEqual({ refused })
          expect(yield* fileSha(target)).toBe(before)
        }
        expect(yield* update(memory, "no-such-id", { vaultAllowed: true, personAttested: true })).toEqual({})
      }),
    ),
  )
})

describe("AC-P4-store S-1, S-2, S10-18: new items and replacements never carry the flag", () => {
  it.live("add builds new notes without the key; a duplicate returns the exported note unchanged", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-add")
        const added = yield* memory.add({
          text: "Vestrel totals are rounded down.",
          source: "agent",
          deviceOnly: true,
          vaultAllowed: true,
        } as Parameters<Memory.Interface["add"]>[0])
        expect("vaultAllowed" in added.item!).toBe(false)
        const before = yield* fileSha(target)
        const same = yield* memory.add({ text: "Plimbo reviews always start from the zorvex list.", source: "user" })
        expect(same.item).toMatchObject({ id: "p4e-001", vaultAllowed: true })
        expect(yield* fileSha(target)).toBe(before)
        const stored = yield* readStore(target)
        expect(stored.items.filter((item) => "vaultAllowed" in item).map((item) => item.id).toSorted()).toEqual([
          "p4e-001",
          "p4e-002",
          "p4e-003",
        ])
      }),
    ),
  )

  it.live("S-2: an exported index entry replaced by an agent's index write loses both keys; deviceOnly is OR-ed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-replace")
        const result = yield* memory.add({
          text: quandelLine("quandel review reopened and closed"),
          source: "agent",
          deviceOnly: false,
          kind: "index",
          missionId: QUANDEL,
        })
        expect(result.item?.id).toBe("p4e-003")
        const stored = byId(yield* readStore(target), "p4e-003")
        expect("vaultAllowed" in stored).toBe(false)
        expect("vaultReportSha256" in stored).toBe(false)
        // S10-04: a replacement never turns deviceOnly from true to false.
        expect(stored.deviceOnly).toBe(true)
      }),
    ),
  )

  it.live("S10-18: a learned lesson is built by name and stores no export key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const cloud = { providerID: "anthropic", api: { url: "https://api.anthropic.com/v1" } } as unknown as Provider.Model
        yield* memory.add({ text: "anchor-p4s-lesson", source: "user" })
        const target = yield* storeFile("anchor-p4s-lesson")
        yield* memory.observeCommand({
          sessionID: "s53",
          command: "npm test",
          exit: 1,
          output: "npm error Missing script: test",
          model: cloud,
        })
        yield* memory.observeCommand({ sessionID: "s53", command: "bun test", exit: 0, output: "", model: cloud })
        const lessons = (yield* readStore(target)).items.filter((item) => item.source === "learned")
        expect(lessons.length).toBe(1)
        expect(Object.keys(lessons[0]!)).toEqual(["id", "source", "time", "text", "deviceOnly", "sessionID", "failed", "worked"])
      }),
    ),
  )

  test("S10-18 pin: addLesson spreads nothing into the stored item", async () => {
    const source = await fs.readFile(path.join(SRC, "memory/memory.ts"), "utf8")
    const body = source.slice(source.indexOf("const addLesson"), source.indexOf("const dropStale"))
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain("...item")
  })
})

// Pure helpers for the consolidation and roll-up sites.
const ids = (prefix: string) => {
  let next = 0
  return () => `${prefix}${String(next++).padStart(4, "0")}`
}
function pad(n: number): Item {
  const date = `2026-10-${String(1 + (n % 28)).padStart(2, "0")}`
  const missionId = `${date}_syn-pad${String(n).padStart(2, "0")}`
  return {
    id: `pad${String(n).padStart(3, "0")}`,
    text: `${date} ${missionId} | padding entry ${n} | triggers: pad | docs/${missionId}/report/report.md`,
    source: "agent",
    deviceOnly: false,
    time: Date.UTC(2026, 9, 1) + n,
    kind: "index",
    missionId,
  }
}

describe("AC-P4-store S-6, S-7: consolidation keeps the flag only under the AND rule", () => {
  test("rule 4: one exported + one not -> key gone; both exported -> kept; rule 1/3 merged body -> key gone", () => {
    const items = fixture("mixed-merge.json").items
    const out = Memory.consolidate(items, { stale: () => false })
    expect(out.changed).toBe(true)
    const a1 = out.items.find((item) => item.id === "p4m-a1")!
    expect(out.items.some((item) => item.id === "p4m-a2")).toBe(false)
    expect("vaultAllowed" in a1).toBe(false)
    expect(a1.deviceOnly).toBe(true)
    expect(out.items.find((item) => item.id === "p4m-b1")).toMatchObject({ vaultAllowed: true, deviceOnly: true })
    expect(out.items.some((item) => item.id === "p4m-b2")).toBe(false)
    const c1 = out.items.find((item) => item.id === "p4m-c1")!
    expect(out.items.some((item) => item.id === "p4m-c2")).toBe(false)
    expect(c1.body).toBe("The zorvex sort needs the quandel ids first.")
    expect("vaultAllowed" in c1).toBe(false)
    expect(c1.deviceOnly).toBe(true)
  })

  test("S-9: the stale-ref filter keeps the flag; S10-04: a merge only ORs deviceOnly", () => {
    const exported = fixture("exported.json").items.find((item) => item.id === "p4e-002")!
    const out = Memory.consolidate([exported], { stale: () => true })
    const kept = out.items[0]!
    expect(kept.refs).toBeUndefined()
    expect(kept).toMatchObject({ vaultAllowed: true, deviceOnly: true })

    const base = { source: "agent" as const, time: 1 }
    const merged = Memory.consolidate(
      [
        { ...base, id: "or-1", text: "Plimbo exports use tabs.", deviceOnly: true, time: 2 },
        { ...base, id: "or-2", text: "Plimbo exports use tabs", deviceOnly: false, body: "Tabs, not commas." },
      ],
      { stale: () => false },
    )
    expect(merged.items).toHaveLength(1)
    expect(merged.items[0]!.deviceOnly).toBe(true)
  })
})

describe("AC-P4-store S-8: roll-up keeps the flag only when every added device-only member was exported", () => {
  const rolled = (exportSecond: boolean) => {
    const items = fixture("mixed-rollup.json").items.map((item) =>
      exportSecond && item.id === "p4r-002" ? { ...item, vaultAllowed: true } : item,
    )
    const out = Memory.rollUp([...items, ...Array.from({ length: 37 }, (_, n) => pad(n))], {
      date: "2026-11-15",
      time: 9000,
      id: ids("x"),
    })
    if ("refused" in out) throw new Error(out.refused)
    return out.items
  }

  test("a non-exported member rolled into an exported roll-up -> key gone; members keep their own flag", () => {
    const items = rolled(false)
    const rollup = items.find((item) => item.id === "p4r-r01")!
    expect(rollup.body!.split("\n")).toHaveLength(3)
    expect(rollup.deviceOnly).toBe(true)
    expect("vaultAllowed" in rollup).toBe(false)
    expect(items.find((item) => item.id === "p4r-003")).toMatchObject({ rolledInto: "p4r-r01", vaultAllowed: true })
    expect("vaultAllowed" in items.find((item) => item.id === "p4r-002")!).toBe(false)
  })

  test("only exported members rolled in -> the roll-up keeps the flag; it never carries a report hash", () => {
    const rollup = rolled(true).find((item) => item.id === "p4r-r01")!
    expect(rollup).toMatchObject({ vaultAllowed: true, deviceOnly: true })
    expect("vaultReportSha256" in rollup).toBe(false)
  })

  test("S10-04: a device-only member makes a roll-up device-only (OR), never the reverse", () => {
    const items = [...Array.from({ length: 39 }, (_, n) => pad(n)), { ...pad(39), deviceOnly: true }]
    const out = Memory.rollUp(items, { date: "2026-11-15", time: 1, id: ids("y") })
    if ("refused" in out) throw new Error(out.refused)
    const rollups = out.items.filter((item) => item.kind === "index_rollup")
    expect(rollups.some((item) => item.deviceOnly)).toBe(true)
    for (const rollup of rollups) expect("vaultAllowed" in rollup).toBe(false)
  })
})

describe("AC-P4-store store compatibility: 1.2.9 store, VERSION 2, S-9", () => {
  it.live("store-1-2-9.json loads unchanged; an unrelated write adds no export key, keeps version 2, makes no .v1", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("store-1-2-9.json", "anchor-p4s-129")
        // "Unchanged" = what the store decoder makes of the 1.2.9 file, with no migration step on top. (A ref holding
        // both `symbol` and `path` decodes as a path ref at BASE too: the MemoryRef union tries the path member first.)
        const expected = decodeItems(fixture("store-1-2-9.json").items)
        expect((yield* memory.get()).items).toEqual(expected)
        yield* memory.add({ text: "Quandel sorts are stable.", source: "user" })
        const stored = yield* readStore(target)
        expect(stored.version).toBe(2)
        expect(stored.items).toHaveLength(expected.length + 1)
        for (const item of stored.items) {
          expect("vaultAllowed" in item).toBe(false)
          expect("vaultReportSha256" in item).toBe(false)
        }
        for (const item of expected) expect(canon(byId(stored, item.id))).toBe(canon(item))
        expect(yield* Effect.promise(() => fs.access(`${target}.v1`).then(() => true, () => false))).toBe(false)
      }),
    ),
  )

  it.live("S-9: remove leaves every other note, flags included, byte-identical", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-remove")
        const before = yield* readStore(target)
        expect(yield* memory.remove("p4e-005")).toBe(true)
        const after = yield* readStore(target)
        expect(after.items.some((item) => item.id === "p4e-005")).toBe(false)
        othersEqual(before, after, ["p4e-005"])
      }),
    ),
  )
})

// S10-13 and the writer pin of 01d §3.1: who may write and who may read the export fields.
const sourceFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)))
    else if (/\.(ts|tsx|txt)$/.test(entry.name)) out.push(full)
  }
  return out
}
const filesWith = async (word: string) => {
  const hits: string[] = []
  for (const file of await sourceFiles(SRC))
    if ((await fs.readFile(file, "utf8")).includes(word)) hits.push(path.relative(SRC, file))
  return hits.toSorted()
}

describe("AC-P4-store grep pins (no agent setter; model routing never reads the field)", () => {
  const WRITERS = ["memory/memory.ts", "server/routes/instance/httpapi/handlers/memory.ts"]
  const READERS = [
    "memory/memory.ts",
    "memory/vault-mirror.ts",
    "server/routes/instance/httpapi/groups/memory.ts",
    "server/routes/instance/httpapi/handlers/memory.ts",
  ]

  test("personAttested appears only in the store and the memory handler; no tool names an export field", async () => {
    for (const hit of await filesWith("personAttested")) expect(WRITERS).toContain(hit)
    for (const word of ["vaultAllowed", "vaultReportSha256"])
      for (const hit of await filesWith(word)) expect(READERS).toContain(hit)
    for (const word of ["vaultAllowed", "vaultReportSha256", "personAttested"])
      expect((await filesWith(word)).filter((hit) => hit.startsWith("tool/"))).toEqual([])
    const remember = await fs.readFile(path.join(SRC, "tool/remember.ts"), "utf8")
    const parameters = remember.slice(remember.indexOf("Parameters"), remember.indexOf("export const REFUSED"))
    for (const word of ["vault", "export", "allowed", "attested"]) expect(parameters.toLowerCase()).not.toContain(word)
  })

  test("S10-13: prompt, recall and onDevice never read the export fields; their deviceOnly filters are unchanged", async () => {
    const source = await fs.readFile(path.join(SRC, "memory/memory.ts"), "utf8")
    const slice = (from: string, to: string) => {
      const start = source.indexOf(from)
      const end = source.indexOf(to, start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      return source.slice(start, end)
    }
    const prompt = slice('prompt: Effect.fn("ProjectMemory.prompt")', 'recall: Effect.fn("ProjectMemory.recall")')
    const recall = slice('recall: Effect.fn("ProjectMemory.recall")', "      onDevice,\n")
    const onDevice = slice('const onDevice: Interface["onDevice"]', "return Service.of(")
    for (const body of [prompt, recall, onDevice])
      for (const word of ["vaultAllowed", "vaultReportSha256", "personAttested"]) expect(body).not.toContain(word)
    expect(prompt).toContain("const items = store.items.filter((item) => local || !item.deviceOnly)")
    expect(recall).toContain("(local || !item.deviceOnly) &&")
    const learn = await fs.readFile(path.join(SRC, "memory/learn.ts"), "utf8")
    for (const word of ["vaultAllowed", "vaultReportSha256", "personAttested"]) expect(learn).not.toContain(word)
  })
})

describe("U-1 (CHAR, 01d §5): a 1.2.10 store decodes under the running build's ProjectMemory.Item", () => {
  test("exported.json decodes; every exported note is still device-only; the field is kept or dropped, never fatal", () => {
    // decodeStore's shape (memory.ts), no decode options: an unknown key is dropped, not an error.
    const decode = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          version: Schema.optional(Schema.Number),
          enabled: Schema.optional(Schema.Boolean),
          items: Schema.Array(ProjectMemory.Item),
        }),
      ),
    )
    const text = require("node:fs").readFileSync(path.join(FIXTURES, "exported.json"), "utf8") as string
    const parsed = decode(text)
    expect(parsed._tag).toBe("Some")
    if (parsed._tag !== "Some") return
    const items = parsed.value.items as readonly Record<string, unknown>[]
    expect(items.map((item) => item.id)).toEqual(["p4e-001", "p4e-002", "p4e-003", "p4e-004", "p4e-005", "p4e-006"])
    for (const id of ["p4e-001", "p4e-002", "p4e-003"]) {
      const item = items.find((entry) => entry.id === id)!
      expect(item.deviceOnly).toBe(true)
      // BASE (1.2.9) Item: the key is dropped. HEAD (1.2.10) Item: it is kept as true. Never false, never an error.
      expect([undefined, true]).toContain(item.vaultAllowed as boolean | undefined)
    }
    const declared = "vaultAllowed" in (ProjectMemory.Item as unknown as { fields: object }).fields
    const kept = items.filter((item) => "vaultAllowed" in item).length
    console.log(`U-1 decoder declares vaultAllowed: ${declared}; decoded items carrying it: ${kept}`)
    expect(kept).toBe(declared ? 3 : 0)
  })
})

// 1.3.0 row 53x (C58(a), C80): the store-level half of S10-04. The route (row 54) refuses an unattested deviceOnly
// change before the store; the store refuses it too, so no other caller can flip the scope. Red at 57684e9b38: the
// store applied an unattested deviceOnly change.
describe("S10-04 store-level guard: an unattested deviceOnly change writes nothing (row 53x)", () => {
  it.live("unattested flip on, flip off and same value: {} and the store file unchanged (red at 57684e9b38)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-scope-guard")
        const before = yield* fileSha(target)
        const cases: [string, UpdateInput][] = [
          // flip on: an any-model note made device-only
          ["p4e-006", { deviceOnly: true }],
          ["p4e-006", { deviceOnly: true, personAttested: false }],
          // flip off: a device-only note, exported or not, made any-model
          ["p4e-005", { deviceOnly: false }],
          ["p4e-001", { deviceOnly: false, personAttested: false }],
          // same value
          ["p4e-001", { deviceOnly: true }],
          ["p4e-006", { deviceOnly: false }],
          // with a text change in the same call: the text is not applied either
          ["p4e-005", { text: "Zorvex audit notes move to the plimbo folder.", deviceOnly: false }],
        ]
        for (const [id, input] of cases) {
          expect(yield* update(memory, id, input)).toEqual({})
          expect(yield* fileSha(target)).toBe(before)
        }
        const stored = yield* readStore(target)
        expect(byId(stored, "p4e-005")).toMatchObject({ deviceOnly: true, text: "Zorvex audit notes stay with the vestrel folder." })
        expect(byId(stored, "p4e-001")).toMatchObject({ deviceOnly: true, vaultAllowed: true })
        expect(byId(stored, "p4e-006").deviceOnly).toBe(false)
      }),
    ),
  )

  it.live("the attested change still applies; an unattested text-only edit is unchanged by the guard", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-scope-attested")
        expect((yield* update(memory, "p4e-005", { deviceOnly: false, personAttested: true })).item?.deviceOnly).toBe(false)
        expect((yield* update(memory, "p4e-006", { deviceOnly: true, personAttested: true })).item?.deviceOnly).toBe(true)
        const text = yield* update(memory, "p4e-002", { text: "Nimbard grids are checked three times." })
        expect(text.item).toMatchObject({ deviceOnly: true, text: "Nimbard grids are checked three times." })
        const stored = yield* readStore(target)
        expect(byId(stored, "p4e-005").deviceOnly).toBe(false)
        expect(byId(stored, "p4e-006").deviceOnly).toBe(true)
      }),
    ),
  )

  it.live("agent paths (remember's add, a learned lesson, consolidation) never clear deviceOnly", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seed("exported.json", "anchor-p4s-agent-paths")
        const deviceOnlyIds = (yield* readStore(target)).items.filter((item) => item.deviceOnly).map((item) => item.id)
        expect(deviceOnlyIds.length).toBeGreaterThan(0)
        // remember from a cloud model: the same text as a device-only note, sent with deviceOnly false.
        const same = yield* memory.add({ text: "Zorvex audit notes stay with the vestrel folder.", source: "agent", deviceOnly: false })
        expect(same.item).toMatchObject({ id: "p4e-005", deviceOnly: true })
        // a learned lesson from a cloud model
        const cloud = { providerID: "anthropic", api: { url: "https://api.anthropic.com/v1" } } as unknown as Provider.Model
        yield* memory.observeCommand({ sessionID: "s53x", command: "npm test", exit: 1, output: "npm error Missing script: test", model: cloud })
        yield* memory.observeCommand({ sessionID: "s53x", command: "bun test", exit: 0, output: "", model: cloud })
        const stored = yield* readStore(target)
        for (const id of deviceOnlyIds) expect(byId(stored, id).deviceOnly).toBe(true)
        // consolidation of the stored notes with an any-model duplicate of a device-only note
        const out = Memory.consolidate(
          [...stored.items, { id: "dup-005", text: "Zorvex audit notes stay with the vestrel folder", source: "agent", deviceOnly: false, time: 1 }],
          { stale: () => false },
        )
        for (const id of deviceOnlyIds) {
          const kept = out.items.find((item) => item.id === id)
          if (kept) expect(kept.deviceOnly).toBe(true)
        }
        expect(out.items.filter((item) => /^Zorvex audit notes stay/.test(item.text)).every((item) => item.deviceOnly)).toBe(true)
      }),
    ),
  )
})
