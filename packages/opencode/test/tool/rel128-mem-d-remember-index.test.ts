// 1.2.8 row 38d, AC-MEMd (N8-346): the remember tool takes kind "index" and missionId (01e §2.4). Red at BASE
// e1f9673772: the parameters have no kind, so the call is decoded into an ordinary note. Synthetic inputs only; HOME is
// a mkdtemp folder and os.homedir is stubbed to it for the whole file.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Memory } from "../../src/memory/memory"
import { Provider } from "../../src/provider/provider"
import { Parameters, RememberTool } from "../../src/tool/remember"
import * as Truncate from "../../src/tool/truncate"
import { Agent } from "@/agent/agent"
import type { Tool } from "@/tool/tool"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let home = ""
let restore: (() => void) | undefined
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "r38d-"))
  const spy = spyOn(os, "homedir").mockReturnValue(home)
  restore = () => spy.mockRestore()
})
afterAll(async () => {
  restore?.()
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

const ID = "2026-11-13_r38d_synthetic"
const REPORT = `docs/${ID}/10_report/report.md`
const line = (outcome = "shipped the synthetic fix") => `2026-11-13 ${ID} | ${outcome} | triggers: alpha, beta | ${REPORT}`

// The four texts of 01e §2.4, verbatim (numbers as the spec writes them).
const TEXTS = {
  index_long:
    "Not saved: a mission index entry is one line of at most 300 characters. Shorten the outcome or the triggers; put detail in body (up to 2000 characters).",
  index_format:
    'Not saved: an index entry reads "YYYY-MM-DD <mission-id> | <outcome> | triggers: k1, k2, k3 | docs/<mission-id>/.../report.md", with missionId equal to the id in the line, at most 5 triggers and the report path inside docs/<mission-id>/.',
  index_body_long:
    "Not saved: the index entry body is over 2000 characters. Keep the detail in the final report and link it; the report path is already in the line.",
  index_full:
    "Not saved: the mission index is full and older entries cannot be rolled up without cutting them. Ask the person to remove or consolidate old entries in the memory view.",
}

const PARAGRAPH =
  'Mission index entry: after the final report of a mission, write exactly one entry with kind "index" and missionId, text "YYYY-MM-DD <mission-id> | <outcome> | triggers: k1, k2, k3 | docs/<mission-id>/10_report/report.md" (one line, at most 300 characters, at most 5 triggers: words a later request about the same subject would contain). Body (optional, up to 2000 characters): key decisions and what is still open. Writing it again for the same mission replaces it.'

const build = (tool: typeof RememberTool) =>
  Effect.gen(function* () {
    const info = yield* tool.pipe(
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
    return yield* info.init()
  })
const ctx = () =>
  ({
    sessionID: SessionID.make("ses_r38d"),
    messageID: MessageID.make("msg_r38d"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    extra: {},
  }) as unknown as Tool.Context

describe("AC-MEMd parameters", () => {
  test("kind and missionId are decoded, and kind takes only \"index\"", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(decode({ kind: "index", missionId: ID, text: line() })).toEqual({ kind: "index", missionId: ID, text: line() })
    expect(() => decode({ kind: "index_rollup", missionId: ID, text: line() })).toThrow()
    expect(() => decode({ kind: "note", text: "x" })).toThrow()
  })

  test("remember.txt carries the 01e §2.4 paragraph and the current-task exception", async () => {
    const text = await Bun.file(path.join(import.meta.dir, "../../src/tool/remember.txt")).text()
    expect(text).toContain(PARAGRAPH)
    expect(text).toContain("anything about the current task only (progress, plans, today's bug), except the mission index entry below")
  })
})

describe("AC-MEMd remember tool", () => {
  it.live("remember {kind: index, missionId, text} saves an index entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* build(RememberTool)
        const result = yield* tool.execute({ kind: "index", missionId: ID, text: line(), body: "decided: A." }, ctx())
        expect(result.metadata.refused).toBeUndefined()
        expect(result.output).toStartWith("Saved as note ")
        const items = (yield* (yield* Memory.Service).get()).items
        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({ kind: "index", missionId: ID, text: line(), body: "decided: A.", source: "agent" })
        expect(items[0]?.refs?.[0]).toEqual({ path: REPORT })
      }),
    ),
  )

  it.live("index_long, index_format and index_body_long return their §2.4 texts and store nothing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* build(RememberTool)
        const cases: [Record<string, unknown>, keyof typeof TEXTS][] = [
          [{ kind: "index", missionId: ID, text: line("x".repeat(400)) }, "index_long"],
          [{ kind: "index", missionId: ID, text: "just words" }, "index_format"],
          [{ kind: "index", missionId: "2026-11-12_other", text: line() }, "index_format"],
          [{ kind: "index", missionId: ID, text: line(), body: "b".repeat(2001) }, "index_body_long"],
          // kind without missionId, kind without text: index_format before the store is asked.
          [{ kind: "index", text: line() }, "index_format"],
          [{ kind: "index", missionId: ID }, "index_format"],
          [{ kind: "index", missionId: ID, text: "   " }, "index_format"],
        ]
        for (const [params, code] of cases) {
          const result = yield* tool.execute(params as never, ctx())
          expect({ params, refused: result.metadata.refused, output: result.output }).toEqual({
            params,
            refused: code,
            output: TEXTS[code],
          })
        }
        expect((yield* (yield* Memory.Service).get()).items).toEqual([])
      }),
    ),
  )

  it.live("index_full from the store returns its §2.4 text", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const seen: unknown[] = []
        const full = Memory.Service.of({
          add: (input: unknown) => {
            seen.push(input)
            return Effect.succeed({ refused: "index_full" })
          },
          onDevice: () => Effect.succeed(false),
        } as unknown as Memory.Interface)
        const tool = yield* build(RememberTool.pipe(Effect.provideService(Memory.Service, full)) as typeof RememberTool)
        const result = yield* tool.execute({ kind: "index", missionId: ID, text: line() }, ctx())
        expect(result.metadata.refused).toBe("index_full")
        expect(result.output).toBe(TEXTS.index_full)
        expect(seen[0]).toMatchObject({ kind: "index", missionId: ID, text: line(), source: "agent" })
      }),
    ),
  )

  it.live("without kind, missionId is ignored and the note is an ordinary note", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* build(RememberTool)
        const result = yield* tool.execute({ missionId: ID, text: "use the synthetic fixture folder" }, ctx())
        expect(result.metadata.refused).toBeUndefined()
        const items = (yield* (yield* Memory.Service).get()).items
        expect(items).toHaveLength(1)
        expect(items[0]?.kind).toBeUndefined()
        expect(items[0]?.missionId).toBeUndefined()
      }),
    ),
  )
})
