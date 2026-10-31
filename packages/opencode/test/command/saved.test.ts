import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Command } from "../../src/command"
import { SavedCommands } from "../../src/command/saved"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { LLM } from "../../src/session/llm"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Provider } from "../../src/provider/provider"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// No model answers here: every draft in this file takes the path a run without a reachable model takes.
const llm = Layer.succeed(
  LLM.Service,
  LLM.Service.of({ stream: () => Stream.fail(new Error("no model")) } as unknown as LLM.Interface),
)
const provider = Layer.succeed(
  Provider.Service,
  Provider.Service.of({ getModel: () => Effect.succeed({}) } as unknown as Provider.Interface),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SavedCommands.node,
      Command.node,
      Session.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      LayerNodePlatform.filesystem,
      InstanceStore.node,
    ]),
    [
      [LLM.node, llm],
      [Provider.node, provider],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const ask = Effect.fn("Test.ask")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const id = MessageID.ascending()
  yield* sessions.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  } as unknown as SessionV1.Part)
})

const run = Effect.fnUntraced(function* (text: string) {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  yield* ask(session.id, text)
  return session.id
})

const projectFile = (dir: string, name: string) => path.join(dir, ".swarm", "command", `${name}.md`)

describe("saved commands", () => {
  it.live(
    "a saved command works straight away, is an ordinary file, and can be removed",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const saved = yield* SavedCommands.Service
        const commands = yield* Command.Service
        expect(yield* commands.get("bump-deps")).toBeUndefined()

        const result = yield* saved.save({ name: "bump-deps", description: "Bump: things", template: "Bump $ARGUMENTS" })
        expect(result.item?.scope).toBe("project")
        expect(yield* Effect.promise(() => fs.readFile(projectFile(dir, "bump-deps"), "utf8"))).toContain("Bump $ARGUMENTS")

        const known = yield* commands.get("bump-deps")
        expect(known?.description).toBe("Bump: things")
        expect(yield* Effect.promise(async () => known?.template)).toBe("Bump $ARGUMENTS")
        expect(known?.hints).toEqual(["$ARGUMENTS"])
        expect((yield* saved.list()).map((item) => item.name)).toContain("bump-deps")

        expect(yield* saved.remove("bump-deps")).toBe(true)
        expect(yield* commands.get("bump-deps")).toBeUndefined()
        expect(yield* saved.remove("bump-deps")).toBe(false)
      }),
    ),
  )

  it.live(
    "a name is never overwritten by accident and bad input is refused",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const saved = yield* SavedCommands.Service
        yield* saved.save({ name: "job", template: "first" })
        expect((yield* saved.save({ name: "job", template: "second" })).refused).toBe("taken")
        expect((yield* saved.save({ name: "job", template: "second", replaces: "other" })).refused).toBe("taken")
        expect(yield* Effect.promise(() => fs.readFile(projectFile(dir, "job"), "utf8"))).toContain("first")
        expect((yield* saved.save({ name: "job", template: "second", replaces: "job" })).item?.template).toBe("second")

        expect((yield* saved.save({ name: "../../evil", template: "x" })).refused).toBe("name")
        expect((yield* saved.save({ name: "review", template: "x" })).refused).toBe("taken")
        expect((yield* saved.save({ name: "memory", template: "x" })).refused).toBe("taken")
        expect((yield* saved.save({ name: "ok", template: "  " })).refused).toBe("empty")
        expect((yield* saved.save({ name: "ok", template: "x".repeat(9000) })).refused).toBe("long")
        expect((yield* saved.save({ name: "ok", template: "use sk-live-4f9aK2mQ7xPz81LmNb60RtYw" })).refused).toBe("secret")
        expect(yield* saved.remove("../../evil")).toBe(false)
      }),
    ),
  )

  it.live(
    "editing keeps what a hand-written command set, and moving it leaves one copy",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const saved = yield* SavedCommands.Service
        const name = `moved-${path.basename(dir).toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 40)
        const file = projectFile(dir, name)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, "---\ndescription: old\nsubtask: true\n---\n\nold words\n")
        })
        yield* saved.save({ name, description: "new", template: "new words", replaces: name })
        const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        expect(text).toContain("subtask: true")
        expect(text).toContain("description: new")
        expect(text).toContain("new words")

        const moved = yield* saved.save({ name, template: "new words", global: true, replaces: name })
        const globalFile = path.join(Global.Path.config, "command", `${name}.md`)
        expect(moved.item?.scope).toBe("global")
        expect(yield* Effect.promise(() => fs.stat(file).then(() => true, () => false))).toBe(false)
        expect(yield* Effect.promise(() => fs.stat(globalFile).then(() => true, () => false))).toBe(true)
        yield* saved.remove(name)
      }),
    ),
  )

  it.live(
    "without a model the draft is built from the run, and the name does not collide",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const saved = yield* SavedCommands.Service
        const sessionID = yield* run("Bump the dependencies and test")
        yield* ask(sessionID, "Use bun test")
        const first = yield* saved.draft(sessionID)
        expect(first.source).toBe("prompts")
        expect(first.template).toContain("Bump the dependencies and test")
        expect(first.template).toContain("Use bun test")
        yield* saved.save({ name: first.name, template: first.template })
        expect((yield* saved.draft(sessionID)).name).not.toBe(first.name)
      }),
    ),
  )

  it.live(
    "the third time a job is asked for it is mentioned, once, until answered",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const saved = yield* SavedCommands.Service
        yield* run("Add dark mode to the settings page")
        const one = yield* run("Bump the dependencies, run the tests and fix whatever breaks")
        expect((yield* saved.repeat(one)).times).toBe(0)
        const two = yield* run("bump dependencies and fix anything that breaks in the tests")
        expect((yield* saved.repeat(two)).times).toBe(0)
        const three = yield* run("Please bump the dependencies again, run tests, fix what breaks")
        expect((yield* saved.repeat(three)).times).toBe(3)

        yield* saved.decline(three)
        expect((yield* saved.repeat(three)).times).toBe(0)
        const four = yield* run("bump the dependencies and fix what breaks")
        expect((yield* saved.repeat(four)).times).toBe(0)
      }),
    ),
  )

  it.live(
    "a job that already has a command is not offered again",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const saved = yield* SavedCommands.Service
        yield* run("Write the release notes for this version")
        yield* run("write release notes for the version")
        const three = yield* run("write the release notes for the new version")
        expect((yield* saved.repeat(three)).times).toBe(3)
        yield* saved.save({ name: "release-notes", description: "Write the release notes for a version", template: "Write notes. $ARGUMENTS" })
        expect((yield* saved.repeat(three)).times).toBe(0)
      }),
    ),
  )
})
