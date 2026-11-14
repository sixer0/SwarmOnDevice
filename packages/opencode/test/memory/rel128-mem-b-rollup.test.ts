// 1.2.8 row 38b, AC-MEMb (N8-344): the mission index roll-up is written, never cut (01e §5, C9, R20-C03/C04). Red at
// BASE e1f9673772: there is no roll-up, a 41st entry is just item 41, and Memory.rollUp does not exist.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
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

const FIXTURE = path.join(
  import.meta.dir,
  "../../../datum-studio/test/fixtures/syn128/mem_index_39_entries.json",
)

// HOME is a fresh temp folder for this file: nothing here may reach a real memory store.
const realHomedir = os.homedir
let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "m38b-"))
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

/** A valid index entry (N8-005). `width` pads the outcome so the line is exactly that many characters. */
function entry(n: number, date: string, opts: { triggers?: string; width?: number; id?: string } = {}): Item {
  const missionId = `${date}_syn-m${String(n).padStart(2, "0")}`
  const report = `docs/${missionId}/report/report.md`
  const triggers = opts.triggers ?? `k${n}, uji`
  const make = (outcome: string) => `${date} ${missionId} | ${outcome} | triggers: ${triggers} | ${report}`
  const outcome = opts.width ? "o".repeat(opts.width - make("").length) : `hasil sintetis ${n}`
  const text = make(outcome)
  expect(ProjectMemory.INDEX_TEXT_PATTERN.test(text)).toBe(true)
  if (opts.width) expect(text.length).toBe(opts.width)
  return {
    id: opts.id ?? `e${String(n).padStart(5, "0")}`,
    text,
    source: "agent",
    deviceOnly: n === 3,
    time: Date.UTC(2026, 0, 1) + n,
    body: `keputusan ${n}; terbuka ${n}`,
    refs: [{ path: report }, { path: `src/m${n}.ts` }],
    untrusted: true,
    kind: "index",
    missionId,
  }
}

const isLive = (item: Item) =>
  item.rolledInto === undefined && (item.kind === "index" || item.kind === "index_rollup")
const ids = (prefix: string) => {
  let next = 0
  return () => `${prefix}${String(next++).padStart(4, "0")}`
}

/** §5.4: 2026-Q1 x 12, 2026-Q2 x 14, 2026-Q3 x 14, given in a shuffled order. */
function workedExample() {
  const q1 = Array.from({ length: 12 }, (_, i) =>
    entry(i + 1, `2026-0${1 + Math.floor(i / 4)}-${String(10 + i).padStart(2, "0")}`, {
      triggers: `alpha, beta, k${i + 1}`,
    }),
  )
  const q2 = Array.from({ length: 14 }, (_, i) => entry(20 + i, `2026-05-${String(10 + i).padStart(2, "0")}`))
  const q3 = Array.from({ length: 14 }, (_, i) => entry(40 + i, `2026-08-${String(10 + i).padStart(2, "0")}`))
  const notes: Item[] = [
    { id: "n00001", text: "catatan biasa satu", source: "user", deviceOnly: false, time: 1 },
    { id: "n00002", text: "catatan biasa dua", source: "agent", deviceOnly: false, time: 2 },
  ]
  // Q1 reversed and interleaved, so the date order in the body is the roll-up's own doing.
  return { items: [notes[0]!, ...q2, ...q1.toReversed(), notes[1]!, ...q3], q1, notes }
}

describe("AC-MEMb roll-up (pure, ids injected)", () => {
  test("§5.4 worked example: Q1 rolls into one roll-up, members kept whole with rolledInto", () => {
    const input = workedExample()
    const out = Memory.rollUp(input.items, { date: "2026-11-14", time: 5000, id: ids("r") })
    if ("refused" in out) throw new Error(out.refused)
    expect(out.items.filter(isLive)).toHaveLength(29)
    const rollups = out.items.filter((item) => item.kind === "index_rollup")
    expect(rollups).toHaveLength(1)
    const rollup = rollups[0]!
    expect(rollup.text).toBe("2026-Q1 roll-up | 12 missions | triggers: alpha, beta, k1, k2, k3 | body")
    expect(rollup.text.length).toBeLessThanOrEqual(ProjectMemory.INDEX_LIMITS.text)
    // 12 body lines `[id] <line>`, in date order.
    expect(rollup.body!.split("\n")).toEqual(input.q1.map((item) => `[${item.id}] ${item.text}`))
    expect(rollup.body!.length).toBeLessThanOrEqual(ProjectMemory.LIMITS.body)
    expect(rollup).toMatchObject({ id: "r0000", source: "agent", deviceOnly: true, untrusted: true, time: 5000 })
    expect(rollup.missionId).toBeUndefined()
    expect(rollup.refs).toBeUndefined()
    // Every member byte-equal plus rolledInto; every other item byte-equal.
    for (const before of input.items) {
      const after = out.items.find((item) => item.id === before.id)!
      const rolled = input.q1.some((item) => item.id === before.id)
      expect(JSON.stringify(after)).toBe(JSON.stringify(rolled ? { ...before, rolledInto: rollup.id } : before))
    }
  })

  test("40 current-quarter entries of 300 characters: two parts, nothing split, live 2 before the insert", () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      entry(i + 1, `2026-10-${String(1 + Math.floor(i / 2)).padStart(2, "0")}`, {
        width: ProjectMemory.INDEX_LIMITS.text,
        triggers: "k01, k02, k03, k04, k05",
      }),
    )
    const out = Memory.rollUp(items, { date: "2026-11-14", time: 7000, id: ids("p") })
    if ("refused" in out) throw new Error(out.refused)
    const parts = out.items.filter((item) => item.kind === "index_rollup")
    expect(parts.map((item) => item.text)).toEqual([
      "2026-Q4 roll-up | 32 missions | triggers: k01, k02, k03, k04, k05 | body",
      "2026-Q4 roll-up part 2 | 8 missions | triggers: k01, k02, k03, k04, k05 | body",
    ])
    expect(out.items.filter(isLive)).toHaveLength(2)
    const lines = parts.flatMap((part) => part.body!.split("\n"))
    expect(lines).toEqual(items.map((item) => `[${item.id}] ${item.text}`))
    for (const part of parts) expect(part.body!.length).toBeLessThanOrEqual(ProjectMemory.LIMITS.body)
    // The 33rd line would have passed 10000 in part 1: it starts part 2 whole.
    expect(parts[0]!.body!.length + 1 + lines[32]!.length).toBeGreaterThan(ProjectMemory.LIMITS.body)
    for (const item of items)
      expect(out.items.find((next) => next.id === item.id)!.rolledInto).toBe(
        lines.indexOf(`[${item.id}] ${item.text}`) < 32 ? parts[0]!.id : parts[1]!.id,
      )
  })

  test("identical input gives identical output", () => {
    const a = Memory.rollUp(workedExample().items, { date: "2026-11-14", time: 1, id: ids("r") })
    const b = Memory.rollUp(workedExample().items, { date: "2026-11-14", time: 1, id: ids("r") })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test("quarterly roll-ups of the oldest year roll into a yearly roll-up (second level)", () => {
    const quarterly: Item[] = Array.from({ length: 40 }, (_, i) => {
      const period = `${2016 + Math.floor(i / 4)}-Q${(i % 4) + 1}`
      return {
        id: `q${String(i).padStart(5, "0")}`,
        text: `${period} roll-up | ${i + 1} missions | triggers: t${i % 4}, umum | body`,
        source: "agent",
        deviceOnly: false,
        time: i,
        body: `[x${i}] baris`,
        kind: "index_rollup",
      }
    })
    const out = Memory.rollUp(quarterly, { date: "2026-11-14", time: 9, id: ids("y") })
    if ("refused" in out) throw new Error(out.refused)
    expect(out.items.filter(isLive)).toHaveLength(37)
    const yearly = out.items.find((item) => item.id === "y0000")!
    expect(yearly.text).toBe("2016 roll-up | 10 missions | triggers: umum, t0, t1, t2, t3 | body")
    expect(yearly.body!.split("\n")).toEqual(quarterly.slice(0, 4).map((item) => `[${item.id}] ${item.text}`))
    for (const item of quarterly.slice(0, 4))
      expect(out.items.find((next) => next.id === item.id)).toEqual({ ...item, rolledInto: "y0000" })
  })

  test("40 sealed yearly roll-ups: index_full, nothing changed", () => {
    const yearly = sealedYearly()
    const out = Memory.rollUp(yearly, { date: "2026-11-14", time: 9, id: ids("z") })
    expect(out).toEqual({ refused: "index_full" })
  })
})

function sealedYearly(): Item[] {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `s${String(i).padStart(5, "0")}`,
    text: `${1980 + i} roll-up | 4 missions | triggers: arsip | body`,
    source: "agent" as const,
    deviceOnly: false,
    time: i,
    body: `[w${i}] baris`,
    kind: "index_rollup",
  }))
}

/** Puts `items` into the current instance's store file and returns its path. */
const seedStore = (items: readonly Item[]) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const marker = `penanda-${Math.random().toString(36).slice(2)}`
    yield* memory.add({ text: marker, source: "user" })
    const dir = path.join(Global.Path.data, "memory")
    expect(dir.startsWith(realHomedir())).toBe(false)
    const target = yield* Effect.promise(async () => {
      for (const name of await fs.readdir(dir)) {
        const file = path.join(dir, name)
        if (name.endsWith(".json") && (await fs.readFile(file, "utf8")).includes(marker)) return file
      }
      throw new Error("store not found")
    })
    yield* Effect.promise(() =>
      fs.writeFile(target, JSON.stringify({ version: 2, enabled: true, items }, null, 2) + "\n", { mode: 0o600 }),
    )
    return target
  })

const newEntry = (n: number, date = "2026-11-14") => {
  const item = entry(n, date)
  return { text: item.text, source: "agent" as const, kind: "index", missionId: item.missionId, body: item.body }
}

describe("AC-MEMb roll-up through the store", () => {
  it.live("§5.4 example: the 41st live entry rolls Q1 and is inserted, live 30", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const input = workedExample()
        yield* seedStore(input.items)
        const result = yield* memory.add(newEntry(90))
        expect(result.refused).toBeUndefined()
        const items = (yield* memory.get()).items
        expect(items.filter(isLive)).toHaveLength(30)
        const rollup = items.find((item) => item.kind === "index_rollup")!
        expect(rollup.text.startsWith("2026-Q1 roll-up | 12 missions | ")).toBe(true)
        for (const before of input.q1)
          expect(items.find((item) => item.id === before.id)).toEqual({ ...before, rolledInto: rollup.id })
        for (const note of input.notes) expect(items.find((item) => item.id === note.id)).toEqual(note)
        expect(items.find((item) => item.id === result.item!.id)).toMatchObject({ kind: "index", missionId: newEntry(90).missionId })
      }),
    ),
  )

  it.live("fixture of 39 entries: the 40th fits, the 41st rolls the oldest quarter", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const fixture = JSON.parse(yield* Effect.promise(() => fs.readFile(FIXTURE, "utf8"))) as { items: Item[] }
        yield* seedStore(fixture.items)
        expect((yield* memory.add(newEntry(91))).refused).toBeUndefined()
        let items = (yield* memory.get()).items
        expect(items.filter(isLive)).toHaveLength(40)
        expect(items.some((item) => item.kind === "index_rollup")).toBe(false)
        expect((yield* memory.add(newEntry(92))).refused).toBeUndefined()
        items = (yield* memory.get()).items
        const q1 = fixture.items.filter((item) => item.kind === "index" && item.text <= "2026-03-99")
        const rollup = items.find((item) => item.kind === "index_rollup")!
        expect(rollup.text.startsWith(`2026-Q1 roll-up | ${q1.length} missions | `)).toBe(true)
        expect(items.filter(isLive)).toHaveLength(40 - q1.length + 1 + 1)
        // Nothing lost: every fixture item is still there, byte-equal apart from rolledInto on the Q1 members.
        for (const before of fixture.items) {
          const after = items.find((item) => item.id === before.id)!
          expect(after).toEqual(q1.includes(before) ? { ...before, rolledInto: rollup.id } : before)
        }
      }),
    ),
  )

  it.live("40 current-quarter entries of 300 characters: 2 parts, live 3", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* seedStore(
          Array.from({ length: 40 }, (_, i) =>
            entry(i + 1, "2026-10-05", { width: ProjectMemory.INDEX_LIMITS.text, triggers: "k01, k02, k03, k04, k05" }),
          ),
        )
        expect((yield* memory.add(newEntry(93))).refused).toBeUndefined()
        const items = (yield* memory.get()).items
        expect(items.filter((item) => item.kind === "index_rollup")).toHaveLength(2)
        expect(items.filter(isLive)).toHaveLength(3)
        expect(items.filter((item) => item.kind === "index")).toHaveLength(41)
      }),
    ),
  )

  it.live("a replacement at 40 live entries rolls nothing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const input = workedExample()
        yield* seedStore(input.items)
        const again = entry(20, "2026-05-10")
        const result = yield* memory.add({ ...newEntry(20, "2026-05-10"), body: "baru" })
        expect(result.item?.id).toBe(again.id)
        const items = (yield* memory.get()).items
        expect(items.filter(isLive)).toHaveLength(40)
        expect(items.some((item) => item.kind === "index_rollup")).toBe(false)
      }),
    ),
  )

  it.live("40 sealed yearly roll-ups: refused index_full, store file byte-equal", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const target = yield* seedStore(sealedYearly())
        const before = yield* Effect.promise(() => fs.readFile(target))
        const result = yield* memory.add(newEntry(94))
        expect(result).toEqual({ refused: "index_full" })
        const after = yield* Effect.promise(() => fs.readFile(target))
        expect(after.equals(before)).toBe(true)
      }),
    ),
  )
})
