import { afterEach, beforeEach, expect, test } from "bun:test"
import { rmSync, readFileSync } from "node:fs"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { loopbackServer } from "./loopback-server"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AutonomyEvent } from "@opencode-ai/schema/autonomy-event"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { GlobalLifecycle } from "../../src/server/global-lifecycle"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import type { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const configFiles = ["swarm.jsonc", "swarm.json", "config.json"].map((name) => path.join(Global.Path.config, name))

// Holds the decider inside its call for as long as a test wants, which is where a reload can catch it.
const stub = {
  calls: 0,
  release: undefined as Deferred.Deferred<Permission.Decided["decision"]> | undefined,
}
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: () =>
      Effect.gen(function* () {
        stub.calls++
        const decision = stub.release ? yield* Deferred.await(stub.release) : ("defer" as const)
        return { decision, decidedBy: "agent:test/stub" as const }
      }),
  }),
)

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Session.node,
      Autonomy.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [Permission.deciderNode, decider],
    ],
  ),
)

// Through the real routes, so that it is the settings change that closes the folder and not a call a test made up.
const served = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([InstanceStore.node, Session.node, Autonomy.node]), [
      [InstanceStore.bootstrapNode, noopBootstrap],
    ]),
    (
      HttpRouter.serve(HttpApiApp.routes, { disableListenLog: true, disableLogger: true }) as Layer.Layer<
        never,
        unknown,
        HttpServer.HttpServer
      >
    ).pipe(
      Layer.provide(layerWebSocketConstructorGlobal),
      Layer.provideMerge(loopbackServer),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  configFiles.forEach((file) => rmSync(file, { force: true }))
}

// Every closing of all folders ends with this, after they are closed.
const disposals: GlobalEvent[] = []
const onEvent = (event: GlobalEvent) => {
  if (event.payload?.type === "global.disposed") disposals.push(event)
}

beforeEach(() => {
  clean()
  stub.calls = 0
  stub.release = undefined
  disposals.length = 0
  GlobalBus.on("event", onEvent)
})
afterEach(() => {
  GlobalBus.off("event", onEvent)
  clean()
})

const list = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* permission.list()
})

const ask = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

// The P probe (C97): a move to a name that changes what runs stays P `file-op` for the decider, with or without Git, and
// needs no file to be there. `mkdir -p` was the probe before C97 made it A with no decider.
const bash = (sessionID: SessionID, command: string, directory: string, id?: PermissionV1.ID) =>
  ({
    id,
    sessionID,
    permission: "bash",
    patterns: [command],
    metadata: { command, workdir: directory },
    always: ["*"],
    ruleset: [],
    canUndo: true,
  }) satisfies PermissionV1.AskInput

const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.timeout("2 seconds"), Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the request to fail")
  })

const rootInMode = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const autonomy = yield* Autonomy.Service
  const root = yield* sessions.create({})
  yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
  return root
})

const fileLines = (root: SessionID) =>
  readFileSync(path.join(folder, `${root}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

const route = (url: string, directory: string, init: RequestInit = {}) =>
  HttpClientRequest.fromWeb(
    new Request(new URL(url, "http://localhost"), {
      ...init,
      headers: { "x-opencode-directory": directory, "content-type": "application/json" },
    }),
  ).pipe(
    HttpClientRequest.setUrl(url),
    HttpClient.execute,
    Effect.flatMap((response) => response.json.pipe(Effect.map((body) => ({ status: response.status, body })))),
  )

const setLibrary = (on: boolean, directory: string) =>
  Effect.gen(function* () {
    const before = disposals.length
    const updated = yield* route("/global/config", directory, {
      method: "PATCH",
      body: JSON.stringify({ knowledge_library: on }),
    })
    expect(updated.status).toBe(200)
    yield* pollWithTimeout(
      Effect.sync(() => (disposals.length > before ? true : undefined)),
      "the settings change never closed the folders",
    )
  })

served.instance("XF-05: open queue, change knowledge_library both ways, the entry stays and reply works", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const test = yield* TestInstance
    const root = yield* sessions.create({})
    const [first, second] = [`per_${"a".repeat(26)}`, `per_${"b".repeat(26)}`]
    yield* Effect.forEach(
      [first, second],
      (requestID) =>
        autonomy.record(root.id, {
          type: "decision",
          sessionID: root.id,
          requestID,
          agent: "build",
          directory: test.directory,
          permission: "bash",
          patterns: ["git push origin main"],
          class: "D",
          category: "outward",
          canUndo: false,
          decidedBy: "gate",
          decision: "defer",
        }),
      { discard: true },
    )
    const entries = [first, second].map((id) => ({ id, sessionID: root.id, permission: "bash", deferred: true }))
    expect((yield* route("/permission", test.directory)).body).toMatchObject(entries)

    yield* setLibrary(false, test.directory)
    expect((yield* route("/permission", test.directory)).body).toMatchObject(entries)
    yield* setLibrary(true, test.directory)
    expect((yield* route("/permission", test.directory)).body).toMatchObject(entries)
    // Closing the folder is not an answer, and nobody is on record as having given one.
    expect(fileLines(root.id).filter((line) => line.type === "outcome")).toEqual([])

    const answer = (requestID: string, reply: string) =>
      route(`/permission/${requestID}/reply`, test.directory, { method: "POST", body: JSON.stringify({ reply }) })
    expect(yield* answer(first, "once")).toMatchObject({ status: 200, body: true })
    expect((yield* route("/permission", test.directory)).body).toMatchObject([entries[1]!])
    expect(yield* answer(second, "reject")).toMatchObject({ status: 200, body: true })
    expect((yield* route("/permission", test.directory)).body).toEqual([])
    expect(fileLines(root.id).filter((line) => line.type === "outcome")).toMatchObject([
      { requestID: first, outcome: "approved_later", by: "person" },
      { requestID: second, outcome: "rejected_later", by: "person" },
    ])

    // Answered, so the next settings change does not bring it back.
    yield* setLibrary(false, test.directory)
    expect((yield* route("/permission", test.directory)).body).toEqual([])
  }),
)

it.instance("XF-05: what the gate held survives closing every folder, and the mode holds with it", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const autonomy = yield* Autonomy.Service
    const root = yield* rootInMode
    expect(yield* failure(ask(bash(root.id, "git push origin main", test.directory)))).toBeInstanceOf(
      PermissionV1.DeferredError,
    )
    const [before] = yield* list

    yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed()
    expect(disposals).toHaveLength(1)

    expect(yield* list).toMatchObject([{ id: before!.id, deferred: true, patterns: ["git push origin main"] }])
    expect(yield* autonomy.isOn({ root: root.id, directory: test.directory })).toBe(true)
    expect(fileLines(root.id).filter((line) => line.type === "outcome")).toEqual([])
    expect((yield* autonomy.readAudit(root.id)).intact).toBe(true)

    // Still waiting for that answer, so asking again is not a second entry.
    expect(yield* failure(ask(bash(root.id, "git push origin main", test.directory)))).toBeInstanceOf(
      PermissionV1.DeferredError,
    )
    expect(yield* list).toHaveLength(1)

    const permission = yield* Permission.Service
    expect(yield* permission.reply({ requestID: before!.id, reply: "once" })).toMatchObject({ id: before!.id })
    expect(fileLines(root.id).filter((line) => line.type === "outcome")).toMatchObject([
      { requestID: before!.id, outcome: "approved_later", by: "person" },
    ])
    yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed()
    expect(yield* list).toEqual([])
  }),
)

it.instance("XF-05: a prompt a person was looking at still ends with the folder, as it always has", () =>
  Effect.gen(function* () {
    // Outside the mode: in it a spend limit waits for nobody (U11 rule 11), and nothing else prompts a person.
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const fiber = yield* ask({
      sessionID: root.id,
      permission: "spend_limit",
      patterns: ["*"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(Effect.exit, Effect.forkScoped)
    yield* pollWithTimeout(
      list.pipe(Effect.map((items) => (items.length === 1 ? true : undefined))),
      "the prompt never appeared",
    )

    yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed()

    const exit = yield* Fiber.join(fiber)
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    expect(yield* list).toEqual([])
  }),
)

it.instance("XF-05: a decider call cut off gives no permission, and it is on record that the call did not run", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const root = yield* rootInMode
    stub.release = yield* Deferred.make<Permission.Decided["decision"]>()
    const requestID = PermissionV1.ID.ascending()
    const fiber = yield* ask(bash(root.id, "mv out.md out.sh", test.directory, requestID)).pipe(Effect.forkScoped)
    yield* pollWithTimeout(
      Effect.sync(() => (stub.calls === 1 ? true : undefined)),
      "the decider was never reached",
    )

    const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    const lines = fileLines(root.id)
    expect(lines.filter((line) => line.type === "decision" && line.decision === "allow")).toEqual([])
    expect(lines.filter((line) => line.type === "outcome")).toMatchObject([
      { requestID, outcome: "not_run", by: "system:decider_interrupted" },
    ])
    // Nobody is left waiting for an answer to it, now or after the folder comes back.
    expect(yield* list).toEqual([])
    yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed()
    expect(yield* list).toEqual([])
  }),
)

it.instance("XF-05: a call the decider holds while the folder is closed is in the new queue, and can be answered", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const root = yield* rootInMode
    stub.release = yield* Deferred.make<Permission.Decided["decision"]>()
    const fiber = yield* failure(ask(bash(root.id, "mv out.md out.sh", test.directory))).pipe(Effect.forkScoped)
    yield* pollWithTimeout(
      Effect.sync(() => (stub.calls === 1 ? true : undefined)),
      "the decider was never reached",
    )

    yield* GlobalLifecycle.disposeAllInstancesAndEmitGlobalDisposed()
    // Somebody looks before the call settles, so the new state is already there when it does.
    expect(yield* list).toEqual([])
    yield* Deferred.succeed(stub.release, "defer")
    expect(yield* Fiber.join(fiber)).toBeInstanceOf(PermissionV1.DeferredError)

    const [held] = yield* list
    expect(held).toMatchObject({ deferred: true, patterns: ["mv out.md out.sh"] })
    const permission = yield* Permission.Service
    expect(yield* permission.reply({ requestID: held!.id, reply: "reject" })).toMatchObject({ id: held!.id })
  }),
)

test("the notice has one definition, and it is the one in the event manifest", () => {
  expect(Autonomy.Blocked).toBe(AutonomyEvent.Blocked)
})
