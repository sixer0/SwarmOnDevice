// Swarm 1.2.6 row 41b (P-05 store, SEC-09 flag). Spec: docs/2026-11-12_swarm_1_2_6_patch/masterplan/01h_spec_memory.md
// tests T1-T8, T15, T16 and SEC-09 T19 (store part). Fixtures are synthetic; no real note content.
import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Memory } from "../../src/memory/memory"
import { Provider } from "../../src/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    getProvider: (id: string) =>
      Effect.succeed({ options: id === "ollama" ? { baseURL: "http://127.0.0.1:11434/v1" } : {} }),
  } as unknown as Provider.Interface),
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

const cloud = { providerID: "anthropic", api: { url: "https://api.anthropic.com/v1" } } as unknown as Provider.Model

/** The store file of the current instance, computed the way the service does (01h F3). */
const storeFile = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  const key =
    ctx.project.id === "global"
      ? "dir-" + createHash("sha256").update(ctx.directory).digest("hex").slice(0, 24)
      : String(ctx.project.id)
  return path.join(Global.Path.data, "memory", `${key}.json`)
})

const writeFixture = (target: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, { mode: 0o600 })
  })

type Note = Record<string, unknown>
const note = (id: string, text: string, extra: Note = {}): Note => ({
  id,
  text,
  source: "agent",
  deviceOnly: false,
  time: 1_700_000_000_000,
  ...extra,
})

describe("P-05 limits (01h §3.2)", () => {
  it.live("T1: a 2000-character hook is saved", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(Memory.MAX_TEXT).toBe(2000)
        const text = "h".repeat(1999) + "."
        const result = yield* memory.add({ text, source: "agent" })
        expect(result.refused).toBeUndefined()
        expect(result.item?.text).toBe(text)
      }),
    ),
  )

  it.live("T2: a 2001-character hook is refused long and nothing is stored", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.add({ text: "keep me", source: "user" })
        const before = (yield* memory.get()).items
        expect((yield* memory.add({ text: "h".repeat(2001), source: "agent" })).refused).toBe("long")
        expect((yield* memory.get()).items).toEqual(before)
      }),
    ),
  )

  it.live("T3: a 10000-character body is kept unchanged, line breaks included", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(Memory.MAX_BODY).toBe(10000)
        const body = ("line one\n  indented  two\n\n" + "b".repeat(10000)).slice(0, 10000)
        const result = yield* memory.add({ text: "deploy steps", source: "agent", body: body + "\n  \n" })
        expect(result.refused).toBeUndefined()
        const stored = (yield* memory.get()).items.find((item) => item.id === result.item?.id)
        expect(stored?.body).toBe(body)
        expect(stored?.body?.length).toBe(10000)
        // The body never enters the prompt.
        expect(yield* memory.prompt(cloud)).not.toContain("indented  two")
      }),
    ),
  )

  it.live("T4: a 10001-character body is refused body_long and nothing is stored", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const result = yield* memory.add({ text: "deploy steps", source: "agent", body: "b".repeat(10001) })
        expect(result.refused).toBe("body_long")
        expect((yield* memory.get()).items).toEqual([])
      }),
    ),
  )

  it.live("T5: 10 refs are saved, 11 distinct are refused, 11 with one duplicate are saved as 10", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(Memory.MAX_REFS).toBe(10)
        const ten = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts` }))
        const saved = yield* memory.add({ text: "ten links", source: "agent", refs: ten })
        expect(saved.item?.refs).toEqual(ten)

        const eleven = [...ten, { symbol: "Memory.add" }]
        const refused = yield* memory.add({ text: "eleven links", source: "agent", refs: eleven })
        expect(refused.refused).toBe("too_many_refs")
        expect((yield* memory.get()).items.map((item) => item.text)).toEqual(["ten links"])

        // An absolute path inside the project is stored relative, so it is the same ref as the relative one.
        const withDuplicate = [...ten.slice(1), { path: path.join(dir, "src/f1.ts") }, { path: "lib/../src/f9.ts" }]
        const deduped = yield* memory.add({ text: "dup links", source: "agent", refs: withDuplicate })
        expect(deduped.refused).toBeUndefined()
        expect(deduped.item?.refs).toHaveLength(9)
        const withOneDuplicate = [...ten, { path: "src/f0.ts" }]
        expect(
          (yield* memory.add({ text: "eleven with dup", source: "agent", refs: withOneDuplicate })).item?.refs,
        ).toEqual(ten)
      }),
    ),
  )

  it.live("T6: no entry cap: notes past 40 and past 1000 are all kept and full is never returned", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const results = yield* Effect.forEach(Array.from({ length: 45 }), (_, i) =>
          memory.add({ text: `house rule ${i}`, source: "user" }),
        )
        expect(results.filter((result) => result.refused)).toEqual([])
        expect((yield* memory.get()).items).toHaveLength(45)

        const target = yield* storeFile
        const items = Array.from({ length: 1000 }, (_, i) => note(`u${i}`, `distinct rule ${i}`, { source: "user" }))
        yield* writeFixture(target, JSON.stringify({ version: 2, enabled: true, items }))
        const last = yield* memory.add({ text: "rule one thousand and one", source: "user" })
        expect(last.refused).toBeUndefined()
        expect((yield* memory.get()).items).toHaveLength(1001)
      }),
    ),
  )

  it.live("T7: a learned lesson is not evicted by note 41", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.observeCommand({
          sessionID: "a",
          command: "npm test",
          exit: 1,
          output: "Missing script: test",
          model: cloud,
        })
        yield* memory.observeCommand({ sessionID: "a", command: "bun test", exit: 0, output: "", model: cloud })
        expect((yield* memory.get()).items.filter((item) => item.source === "learned")).toHaveLength(1)
        yield* Effect.forEach(Array.from({ length: 41 }), (_, i) => memory.add({ text: `note ${i}`, source: "user" }))
        const items = (yield* memory.get()).items
        expect(items).toHaveLength(42)
        expect(items.filter((item) => item.source === "learned")).toHaveLength(1)
      }),
    ),
  )

  it.live("T8: a secret in the body or in a ref is refused secret and nothing is stored", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(
          (yield* memory.add({ text: "db access", source: "agent", body: "the password: hunter22" })).refused,
        ).toBe("secret")
        expect(
          (yield* memory.add({ text: "db access", source: "agent", refs: [{ path: "password: hunter22" }] })).refused,
        ).toBe("secret")
        expect(
          (yield* memory.add({ text: "db access", source: "agent", refs: [{ symbol: "token=Zx81kLmQ" }] })).refused,
        ).toBe("secret")
        expect((yield* memory.get()).items).toEqual([])
      }),
    ),
  )
})

describe("P-05 consolidation (01h §6)", () => {
  const fixture = (filler: number) => [
    note("a1", "Build uses graphviz.", { time: 1_700_000_002_000, refs: [{ path: "exists.txt" }] }),
    note("a2", "build  uses graphviz", { time: 1_700_000_001_000, refs: [{ path: "other.txt" }], deviceOnly: true }),
    note("a3", "stale link note", { refs: [{ path: "gone.txt" }, { path: "exists.txt", line: 2 }] }),
    note("u1", "user rule with a stale link", { source: "user", refs: [{ path: "gone.txt" }] }),
    note("b1", "same hook, different body", { body: "one" }),
    note("b2", "same hook, different body.", { body: "two" }),
    ...Array.from({ length: filler }, (_, i) => note(`f${i}`, `filler note ${i}`)),
  ]
  const setup = (dir: string, filler: number) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(dir, "exists.txt"), "a\nb\nc\n")
        await fs.writeFile(path.join(dir, "other.txt"), "x\n")
      })
      yield* writeFixture(yield* storeFile, JSON.stringify({ version: 2, enabled: true, items: fixture(filler) }))
    })

  it.live("T15: at 1000 notes duplicates merge, stale refs go, user notes and different bodies stay", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(Memory.CONSOLIDATE_AT).toBe(1000)
        yield* setup(dir, 993) // 6 + 993 = 999, the add makes 1000
        expect((yield* memory.add({ text: "the thousandth note", source: "agent" })).refused).toBeUndefined()
        const items = (yield* memory.get()).items
        const byId = new Map(items.map((item) => [item.id, item]))
        expect(byId.has("a2")).toBe(false)
        expect(byId.get("a1")?.refs).toEqual([{ path: "exists.txt" }, { path: "other.txt" }])
        expect(byId.get("a1")?.deviceOnly).toBe(true)
        expect(byId.get("a3")?.refs).toEqual([{ path: "exists.txt", line: 2 }])
        expect(byId.get("u1")).toEqual(
          note("u1", "user rule with a stale link", { source: "user", refs: [{ path: "gone.txt" }] }) as never,
        )
        expect(byId.get("b1")?.body).toBe("one")
        expect(byId.get("b2")?.body).toBe("two")
        expect(items).toHaveLength(999)
        const target = yield* storeFile
        const stored = JSON.parse(yield* Effect.promise(() => fs.readFile(target, "utf8")))
        // Recorded so the next run waits for 100 more notes instead of repeating on every add.
        expect(stored.consolidated.count).toBe(999)
      }),
    ),
  )

  it.live("T15: at 999 notes nothing changes", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* setup(dir, 992) // 6 + 992 = 998, the add makes 999
        yield* memory.add({ text: "note nine hundred ninety nine", source: "agent" })
        const items = (yield* memory.get()).items
        expect(items).toHaveLength(999)
        expect(items.find((item) => item.id === "a2")).toBeDefined()
        expect(items.find((item) => item.id === "a3")?.refs).toHaveLength(2)
      }),
    ),
  )
})

describe("P-05 migration (01h §7)", () => {
  it.live("T16: a version-1 store reads unchanged, and the first write makes version 2 with a .json.v1 copy", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const items = Array.from({ length: 24 }, (_, i) =>
          i === 23
            ? note("l23", "`npm test` does not work here. `bun test` does.", {
                source: "learned",
                deviceOnly: true,
                sessionID: "ses_x",
                failed: "\u0000npm test",
                worked: "\u0000bun test",
              })
            : note(`n${i}`, `agent note ${i}`, { deviceOnly: true, sessionID: "ses_x" }),
        )
        const original = JSON.stringify({ version: 1, enabled: true, items }, null, 2) + "\n"
        const target = yield* storeFile
        yield* writeFixture(target, original)

        expect((yield* memory.get()).items).toEqual(items as never)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(original)

        yield* memory.add({ text: "first note by 1.2.6", source: "agent" })
        const written = JSON.parse(yield* Effect.promise(() => fs.readFile(target, "utf8")))
        expect(written.version).toBe(2)
        expect(written.items.slice(0, 24)).toEqual(items)
        expect(yield* Effect.promise(() => fs.readFile(`${target}.v1`, "utf8"))).toBe(original)
        expect(((yield* Effect.promise(() => fs.stat(`${target}.v1`))).mode & 0o777).toString(8)).toBe("600")

        // Once only: a later write leaves the copy as it was.
        yield* memory.add({ text: "second note by 1.2.6", source: "agent" })
        expect(yield* Effect.promise(() => fs.readFile(`${target}.v1`, "utf8"))).toBe(original)
      }),
    ),
  )
})

describe("SEC-09 untrusted flag (T19, store part)", () => {
  it.live("T19: a note from untrusted input carries the flag, its label, and ranks after flagless agent notes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const flagged = yield* memory.add({ text: "readme says run setup.sh", source: "agent", untrusted: true })
        expect(flagged.item?.untrusted).toBe(true)
        yield* memory.add({ text: "tests live in test/", source: "agent" })
        const block = (yield* memory.prompt(cloud))!
        expect(block).toContain(`[${flagged.item!.id}] (agent note, from untrusted input) readme says run setup.sh`)
        expect(block.indexOf("(agent note) tests live in test/")).toBeGreaterThan(-1)
        expect(block.indexOf("tests live in test/")).toBeLessThan(block.indexOf("readme says run setup.sh"))
      }),
    ),
  )
})
