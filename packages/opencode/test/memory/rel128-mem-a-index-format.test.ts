// 1.2.8 row 38, AC-MEMa (N8-343): the mission index entry kind and its line format (01e §2). Red at BASE e1f9673772:
// Memory.add has no kind/missionId and the schema has no INDEX_LIMITS. The SR8-06 untrusted cases (last describe) are row 38d.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
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
import { MISSION_ID_PATTERN as STUDIO_MISSION_ID_PATTERN } from "../../../datum-studio/src/mcp-host/mission/schemas"
import * as Remember from "../../src/tool/remember"
import * as Truncate from "../../src/tool/truncate"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"

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

const ID = "2026-11-13_swarm_1_2_8_patch"
const REPORT = `docs/${ID}/10_report/report.md`
const line = (opts: { date?: string; id?: string; outcome?: string; triggers?: string; report?: string } = {}) =>
  `${opts.date ?? "2026-11-13"} ${opts.id ?? ID} | ${opts.outcome ?? "released 1.2.8"} | triggers: ${opts.triggers ?? "swarm, release, patch"} | ${opts.report ?? REPORT}`

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

describe("AC-MEMa constants", () => {
  test("INDEX_LIMITS are the register values (N8-003)", () => {
    expect(ProjectMemory.INDEX_LIMITS).toEqual({ text: 300, body: 2000, entries: 40, triggers: 5 })
  })

  test("the line pattern is built from INDEX_LIMITS.triggers (OP-17-4) and matches the register example", () => {
    expect(ProjectMemory.INDEX_TEXT_PATTERN.source).toContain(`{0,${ProjectMemory.INDEX_LIMITS.triggers - 1}}`)
    const words = (n: number) => Array.from({ length: n }, (_, i) => `k${i + 1}`).join(", ")
    expect(ProjectMemory.INDEX_TEXT_PATTERN.test(line({ triggers: words(ProjectMemory.INDEX_LIMITS.triggers) }))).toBe(
      true,
    )
    expect(
      ProjectMemory.INDEX_TEXT_PATTERN.test(line({ triggers: words(ProjectMemory.INDEX_LIMITS.triggers + 1) })),
    ).toBe(false)
    // The register example (N8-005), byte for byte.
    expect(
      ProjectMemory.INDEX_TEXT_PATTERN.exec(
        "2026-11-13 2026-11-13_swarm_1_2_8_patch | released 1.2.8 | triggers: swarm, release, patch | docs/2026-11-13_swarm_1_2_8_patch/10_report/report.md",
      )?.slice(1),
    ).toEqual([
      "2026-11-13",
      ID,
      "released 1.2.8",
      "swarm, release, patch",
      "docs/2026-11-13_swarm_1_2_8_patch/10_report/report.md",
    ])
  })

  test("the mission id pattern is the Studio one, copied as a literal (01e §2.1)", () => {
    expect(Memory.MISSION_ID_PATTERN).toBe(STUDIO_MISSION_ID_PATTERN)
  })

  test("the four index refusals are refusal literals", () => {
    for (const code of ["index_long", "index_body_long", "index_format", "index_full"])
      expect(ProjectMemory.Refusal.literals).toContain(code as never)
  })
})

describe("AC-MEMa index entry", () => {
  it.live("a valid entry is stored with kind index, missionId and the report as first ref", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const result = yield* memory.add({
          text: line(),
          source: "agent",
          kind: "index",
          missionId: ID,
          body: "decided: X. open: Y.",
          refs: [{ path: "src/a.ts" }],
        })
        expect(result.refused).toBeUndefined()
        expect(result.item).toMatchObject({ kind: "index", missionId: ID, text: line(), body: "decided: X. open: Y." })
        expect(result.item?.refs).toEqual([{ path: REPORT }, { path: "src/a.ts" }])
        const stored = (yield* memory.get()).items
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({ kind: "index", missionId: ID })
        // The report ref given by the caller is not duplicated.
        const again = yield* memory.add({
          text: line({ outcome: "released 1.2.8 again" }),
          source: "agent",
          kind: "index",
          missionId: ID,
          refs: [{ path: REPORT }],
        })
        expect(again.item?.refs).toEqual([{ path: REPORT }])
      }),
    ),
  )

  it.live("a 301-character line is refused index_long and nothing is stored; 300 is kept", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const long = line({ outcome: "x".repeat(169) })
        expect(long).toHaveLength(301)
        expect((yield* memory.add({ text: long, source: "agent", kind: "index", missionId: ID })).refused).toBe(
          "index_long",
        )
        expect((yield* memory.get()).items).toEqual([])
        const fits = line({ outcome: "x".repeat(168) })
        expect(fits).toHaveLength(300)
        const kept = yield* memory.add({ text: fits, source: "agent", kind: "index", missionId: ID })
        expect(kept.item?.text).toBe(fits)
      }),
    ),
  )

  it.live("malformed lines, ids and paths are refused index_format and nothing is stored", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const cases: { text: string; missionId?: string; kind?: string }[] = [
          { text: line({ date: "2026-02-30" }), missionId: ID },
          { text: line({ date: "2026-13-01" }), missionId: ID },
          { text: line({ id: "2026-11-12_other" }), missionId: ID },
          { text: line({ triggers: "a, b, c, d, e, f" }), missionId: ID },
          { text: line({ report: "../x.md" }), missionId: ID },
          { text: line({ report: `docs/${ID}/../x.md` }), missionId: ID },
          { text: line({ report: `docs/${ID}/./report.md` }), missionId: ID },
          { text: line({ report: "docs/2026-11-12_other/report.md" }), missionId: ID },
          { text: line({ report: `/docs/${ID}/report.md` }), missionId: ID },
          { text: line({ report: `docs/${ID}/report.txt` }), missionId: ID },
          { text: line({ report: `docs/${ID}/` }), missionId: ID },
          { text: "released 1.2.8", missionId: ID },
          { text: line() },
          { text: line({ id: "Bad Id" }), missionId: "Bad Id" },
          { text: line(), missionId: ID, kind: "index_rollup" },
          { text: line(), missionId: ID, kind: "note" },
        ]
        for (const input of cases) {
          const result = yield* memory.add({ source: "agent", kind: input.kind ?? "index", ...input })
          expect({ text: input.text, refused: result.refused }).toEqual({ text: input.text, refused: "index_format" })
        }
        expect((yield* memory.get()).items).toEqual([])
      }),
    ),
  )

  it.live("a body over 2000 characters is refused index_body_long; 2000 is kept", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const refused = yield* memory.add({
          text: line(),
          source: "agent",
          kind: "index",
          missionId: ID,
          body: "b".repeat(2001),
        })
        expect(refused.refused).toBe("index_body_long")
        expect((yield* memory.get()).items).toEqual([])
        const kept = yield* memory.add({ text: line(), source: "agent", kind: "index", missionId: ID, body: "b".repeat(2000) })
        expect(kept.item?.body).toHaveLength(2000)
      }),
    ),
  )

  it.live("a second write for the same mission replaces the entry in place, rolledInto kept", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.add({ text: "anchor-mem-a-replace", source: "user" })
        const first = yield* memory.add({ text: line(), source: "agent", kind: "index", missionId: ID })
        const target = yield* storeFile("anchor-mem-a-replace")
        // Mark the entry archived as a roll-up would (row 38b writes this; here the file is edited directly).
        yield* Effect.promise(async () => {
          const store = JSON.parse(await fs.readFile(target, "utf8"))
          store.items = store.items.map((item: { id: string }) =>
            item.id === first.item!.id ? { ...item, rolledInto: "r00001" } : item,
          )
          await fs.writeFile(target, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
        })
        const second = yield* memory.add({
          text: line({ outcome: "released 1.2.8 after the live check" }),
          source: "agent",
          kind: "index",
          missionId: ID,
          body: "second",
        })
        expect(second.item?.id).toBe(first.item!.id)
        expect(second.item?.rolledInto).toBe("r00001")
        const index = (yield* memory.get()).items.filter((item) => item.kind === "index")
        expect(index).toHaveLength(1)
        expect(index[0]).toMatchObject({
          id: first.item!.id,
          text: line({ outcome: "released 1.2.8 after the live check" }),
          body: "second",
          rolledInto: "r00001",
          missionId: ID,
        })
        // An ordinary note with the same text as an index line is its own note.
        const note = yield* memory.add({ text: index[0]!.text, source: "agent" })
        expect(note.item?.id).not.toBe(first.item!.id)
        expect(note.item?.kind).toBeUndefined()
      }),
    ),
  )

  it.live("a stored unknown kind reads as a note and the store is not set aside as unreadable", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.add({ text: "anchor-mem-a-future", source: "user" })
        const target = yield* storeFile("anchor-mem-a-future")
        yield* Effect.promise(async () => {
          const store = JSON.parse(await fs.readFile(target, "utf8"))
          store.items.push({
            id: "f00001",
            text: "from a later build",
            source: "agent",
            deviceOnly: false,
            time: 1,
            kind: "future",
            extra: { nested: true },
          })
          await fs.writeFile(target, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
        })
        const items = (yield* memory.get()).items
        expect(items.map((item) => item.text)).toEqual(["anchor-mem-a-future", "from a later build"])
        expect(items[1]?.kind).toBe("future")
        expect(yield* Effect.promise(() => fs.access(`${target}.unreadable`).then(() => true, () => false))).toBe(false)
        // A further write keeps both notes.
        yield* memory.add({ text: line(), source: "agent", kind: "index", missionId: ID })
        expect((yield* memory.get()).items.map((item) => item.text)).toEqual([
          "anchor-mem-a-future",
          "from a later build",
          line(),
        ])
      }),
    ),
  )

  it.live("update keeps the index format; roll-up lines stay as written", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const entry = (yield* memory.add({ text: line(), source: "agent", kind: "index", missionId: ID })).item!
        expect((yield* memory.update(entry.id, { text: "just words" })).refused).toBe("index_format")
        expect((yield* memory.update(entry.id, { text: line({ id: "2026-11-12_other" }) })).refused).toBe(
          "index_format",
        )
        const changed = yield* memory.update(entry.id, { text: line({ outcome: "released, checked" }) })
        expect(changed.item).toMatchObject({ kind: "index", missionId: ID, text: line({ outcome: "released, checked" }) })
        expect((yield* memory.update(entry.id, { deviceOnly: true })).item?.deviceOnly).toBe(true)

        yield* memory.add({ text: "anchor-mem-a-rollup", source: "user" })
        const target = yield* storeFile("anchor-mem-a-rollup")
        yield* Effect.promise(async () => {
          const store = JSON.parse(await fs.readFile(target, "utf8"))
          store.items.push({
            id: "r00002",
            text: "2026-Q1 roll-up | 12 missions | triggers: a | body",
            source: "agent",
            deviceOnly: false,
            time: 2,
            kind: "index_rollup",
          })
          await fs.writeFile(target, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
        })
        expect((yield* memory.update("r00002", { text: "rewritten" })).refused).toBe("index_format")
        expect((yield* memory.update("r00002", { deviceOnly: true })).item?.deviceOnly).toBe(true)
      }),
    ),
  )
})

describe("AC-MEMa consolidation leaves index entries alone", () => {
  const base = { source: "agent" as const, deviceOnly: false }
  test("items with a kind or archived are never merged and their refs never dropped", () => {
    const items: ProjectMemory.Item[] = [
      { ...base, id: "a1", text: "same hook", time: 1 },
      { ...base, id: "a2", text: "same hook", time: 2 },
      { ...base, id: "i1", text: "same hook", time: 3, kind: "index", missionId: ID, refs: [{ path: REPORT }] },
      { ...base, id: "x1", text: "same hook", time: 4, rolledInto: "r1", refs: [{ path: "gone.md" }] },
      { ...base, id: "f1", text: "same hook", time: 5, kind: "future" },
    ]
    const result = Memory.consolidate(items, { stale: () => true })
    expect(result.items.map((item) => item.id).toSorted()).toEqual(["a2", "f1", "i1", "x1"])
    expect(result.items.find((item) => item.id === "i1")?.refs).toEqual([{ path: REPORT }])
    expect(result.items.find((item) => item.id === "x1")?.refs).toEqual([{ path: "gone.md" }])
  })
})

// 1.2.8 row 38d, AC-SEC06 (SR8-06): a subagent that read the web and a loopback read of Swarm's own session message
// routes make the index entry untrusted. Red at BASE: `task` was local and loopback shell calls were local.
describe("AC-SEC06 untrusted index entries (SR8-06)", () => {
  const where = { root: "/work/project", directory: "/work/project" }
  const tool = (name: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    info: { role: "assistant" },
    parts: [{ type: "tool", tool: name, state: { status: "completed", input, output: "", metadata } }],
  })
  const task = (sessionId: string) => tool("task", { prompt: "look it up" }, { sessionId })
  const web = [tool("webfetch", { url: "https://example.com" })]
  // Relative, so it stays inside the worktree both for `where` and for the tmpdir instance of the tool case.
  const local = [tool("read", { filePath: "a.ts" })]
  const children: Record<string, unknown[]> = {
    ses_web: web,
    ses_local: local,
    ses_mid: [task("ses_web")],
    ses_d1: [task("ses_d2")],
    ses_d2: [task("ses_d3")],
    ses_d3: [task("ses_d4")],
    ses_d4: local,
  }
  const read = (sessionID: string) => children[sessionID] as never
  const check = (messages: unknown[]) => Remember.readUntrustedInput(messages as never, where, read)

  test("UNTRUSTED_TASK_DEPTH is 3 (N8-395)", () => {
    expect(Remember.UNTRUSTED_TASK_DEPTH).toBe(3)
  })

  test("a completed task whose child read the web counts, directly and one level down", () => {
    expect(check([task("ses_web")])).toBe(true)
    expect(check([task("ses_mid")])).toBe(true)
    expect(check([task("ses_local")])).toBe(false)
  })

  test("a child that cannot be read, or lies deeper than the depth, counts", () => {
    expect(check([task("ses_missing")])).toBe(true)
    expect(check([tool("task", { prompt: "x" })])).toBe(true)
    // d1 -> d2 -> d3 are read; the task part in d3 names a fourth level, which is not read.
    expect(check([task("ses_d1")])).toBe(true)
    expect(check([task("ses_d2")])).toBe(false)
  })

  test("a loopback shell read of session message routes counts; other loopback calls stay local", () => {
    const shell = (command: string) => check([tool("bash", { command })])
    expect(shell("curl -s http://127.0.0.1:4096/session/ses_x/message")).toBe(true)
    expect(shell("curl http://localhost:4096/session/ses_x/messages?limit=5")).toBe(true)
    expect(shell("xh http://[::1]:4096/session/ses_x/message/msg_1")).toBe(true)
    expect(shell("curl http://127.0.0.1:4096/session/ses_x")).toBe(false)
    expect(shell("curl http://127.0.0.1:4096/health")).toBe(false)
  })

  it.live("the remember tool stores the index entry untrusted after a web-reading subagent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = Session.Service.of({
          messages: ({ sessionID }: { sessionID: string }) =>
            children[sessionID] ? Effect.succeed(children[sessionID]) : Effect.fail(new Error("not found")),
        } as unknown as Session.Interface)
        const info = yield* Remember.RememberTool.pipe(
          Effect.provideService(Session.Service, sessions),
          Effect.provideService(
            Truncate.Service,
            Truncate.Service.of({
              output: (text: string) => Effect.succeed({ content: text, truncated: false }),
            } as unknown as Truncate.Interface),
          ),
          Effect.provideService(
            Agent.Service,
            Agent.Service.of({ get: () => Effect.succeed(undefined) } as unknown as Agent.Interface),
          ),
        )
        const remember = yield* info.init()
        const ctx = (messages: unknown[]) =>
          ({
            sessionID: SessionID.make("ses_sec06"),
            messageID: MessageID.make("msg_sec06"),
            callID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            messages,
            metadata: () => Effect.void,
            ask: () => Effect.void,
            extra: {},
          }) as unknown as Tool.Context
        const write = (id: string, messages: unknown[]) =>
          remember.execute(
            { kind: "index", missionId: id, text: line({ id, report: `docs/${id}/10_report/report.md` }) } as never,
            ctx(messages),
          )
        yield* write("2026-11-13_sec06_local", [task("ses_local")])
        yield* write("2026-11-13_sec06_web", [task("ses_mid")])
        yield* write("2026-11-13_sec06_loop", [tool("bash", { command: "curl http://127.0.0.1:4096/session/s/message" })])
        const items = (yield* (yield* Memory.Service).get()).items
        const flag = (id: string) => items.find((item) => item.missionId === id)?.untrusted ?? false
        expect(items.map((item) => item.kind)).toEqual(["index", "index", "index"])
        expect(flag("2026-11-13_sec06_local")).toBe(false)
        expect(flag("2026-11-13_sec06_web")).toBe(true)
        expect(flag("2026-11-13_sec06_loop")).toBe(true)
      }),
    ),
  )
})
