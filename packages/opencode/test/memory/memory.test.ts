import { describe, expect } from "bun:test"
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
const local = { providerID: "ollama", api: { url: "" } } as unknown as Provider.Model

const run = (
  memory: Memory.Interface,
  sessionID: string,
  command: string,
  exit: number,
  output = "",
  workdir?: string,
) => memory.observeCommand({ sessionID, command, exit, output, workdir, model: cloud })

describe("project memory", () => {
  it.live("keeps a note and hands it to the next session's prompt", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect(yield* memory.prompt(cloud)).toBeUndefined()
        const added = yield* memory.add({ text: "  always   use pnpm ", source: "agent" })
        expect(added.item?.text).toBe("always use pnpm")
        expect(yield* memory.prompt(cloud)).toContain("always use pnpm")
      }),
    ),
  )

  it.live("refuses credentials, and does not store them anywhere", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        expect((yield* memory.add({ text: "the password: hunter22", source: "user" })).refused).toBe("secret")
        expect((yield* memory.get()).items).toEqual([])
      }),
    ),
  )

  it.live("a note from an on-device session never reaches a cloud model until the user allows it", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        const added = yield* memory.add({ text: "customer ids live in vault", source: "agent", deviceOnly: true })
        expect(yield* memory.onDevice(local)).toBe(true)
        expect(yield* memory.onDevice(cloud)).toBe(false)
        expect(yield* memory.prompt(cloud)).toBeUndefined()
        expect(yield* memory.prompt(local)).toContain("customer ids live in vault")
        yield* memory.update(added.item!.id, { deviceOnly: false })
        expect(yield* memory.prompt(cloud)).toContain("customer ids live in vault")
      }),
    ),
  )

  it.live("turned off, sessions get nothing and nothing new is learned, but the notes stay", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.add({ text: "use pnpm", source: "user" })
        yield* memory.setEnabled(false)
        expect(yield* memory.prompt(cloud)).toBeUndefined()
        yield* run(memory, "s", "npm test", 1, "npm error Missing script: test")
        yield* run(memory, "s", "bun test", 0)
        expect((yield* memory.get()).items.map((item) => item.text)).toEqual(["use pnpm"])
      }),
    ),
  )

  it.live("is stored outside the repository and readable only by the user", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* memory.add({ text: "use pnpm", source: "user" })
        expect(yield* Effect.promise(() => fs.readdir(dir))).not.toContain("memory")
        const files = yield* Effect.promise(() => fs.readdir(path.join(Global.Path.data, "memory")))
        const mine = yield* Effect.promise(async () => {
          for (const name of files) {
            const target = path.join(Global.Path.data, "memory", name)
            if ((await fs.readFile(target, "utf8")).includes("use pnpm")) return target
          }
        })
        expect(((yield* Effect.promise(() => fs.stat(mine!))).mode & 0o777).toString(8)).toBe("600")
      }),
    ),
  )
})

describe("learning from commands", () => {
  it.live("a failed start followed by what worked becomes a note", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* run(memory, "s", "npm test", 1, 'npm error Missing script: "test"')
        yield* run(memory, "s", "ls", 0)
        yield* run(memory, "s", "bun test", 0, "12 pass")
        const items = (yield* memory.get()).items
        expect(items.map((item) => item.text)).toEqual([
          "`npm test` does not work here. `bun test` does.",
        ])
        expect(items[0]?.source).toBe("learned")
      }),
    ),
  )

  it.live("a failing test is not a lesson", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* run(memory, "s", "bun test", 1, "FAIL refunds.test.ts\nexpected 2 received 3")
        yield* run(memory, "s", "bun test refunds", 0, "1 pass")
        expect((yield* memory.get()).items).toEqual([])
      }),
    ),
  )

  it.live("sessions do not pair each other's commands", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* run(memory, "a", "npm test", 1, "Missing script: test")
        yield* run(memory, "b", "bun test", 0)
        expect((yield* memory.get()).items).toEqual([])
      }),
    ),
  )

  it.live("repeating a mistake does not repeat the note, and a note that stops being true removes itself", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* run(memory, "a", "npm test", 1, "Missing script: test")
        yield* run(memory, "a", "bun test", 0)
        yield* run(memory, "b", "npm test", 1, "Missing script: test")
        yield* run(memory, "b", "bun test", 0)
        expect((yield* memory.get()).items.length).toBe(1)
        yield* run(memory, "c", "npm test", 0, "12 pass")
        expect((yield* memory.get()).items).toEqual([])
      }),
    ),
  )

  it.live("what the user rewrites is theirs: the runtime will not retract it", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* run(memory, "a", "npm test", 1, "Missing script: test")
        yield* run(memory, "a", "bun test", 0)
        const item = (yield* memory.get()).items[0]!
        yield* memory.update(item.id, { text: "use bun test, npm has no test script" })
        yield* run(memory, "b", "npm test", 0)
        expect((yield* memory.get()).items.map((note) => [note.text, note.source])).toEqual([
          ["use bun test, npm has no test script", "user"],
        ])
      }),
    ),
  )

  it.live("learned notes give way when memory is full, chosen notes do not", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* run(memory, "a", "npm test", 1, "Missing script: test")
        yield* run(memory, "a", "bun test", 0)
        yield* Effect.forEach(Array.from({ length: Memory.MAX_ITEMS - 1 }), (_, i) =>
          memory.add({ text: `note ${i}`, source: "user" }),
        )
        expect((yield* memory.add({ text: "one more", source: "user" })).item?.text).toBe("one more")
        const items = (yield* memory.get()).items
        expect(items.some((item) => item.source === "learned")).toBe(false)
        expect((yield* memory.add({ text: "too many", source: "user" })).refused).toBe("full")
      }),
    ),
  )
})
