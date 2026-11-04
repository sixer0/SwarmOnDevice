// The list every client loads a folder's prompts from, through the real route. Encoding it is all or nothing, so one
// prompt it cannot encode would hide the others: a tool's optional parameter left out is the ordinary way to get one.

import { NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { loopbackServer } from "./loopback-server"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { ServerAuth } from "../../src/server/auth"
import { AutonomyApi, AutonomyPaths } from "../../src/server/routes/instance/httpapi/groups/autonomy"
import { PermissionApi } from "../../src/server/routes/instance/httpapi/groups/permission"
import { autonomyHandlers } from "../../src/server/routes/instance/httpapi/handlers/autonomy"
import { permissionHandlers } from "../../src/server/routes/instance/httpapi/handlers/permission"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { Truncate } from "../../src/tool/truncate"
import { WebFetchTool } from "../../src/tool/webfetch"
import { TestInstance } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const clean = () => rmSync(folder, { recursive: true, force: true })
beforeEach(clean)
afterEach(clean)

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([
        Permission.node,
        Session.node,
        Autonomy.node,
        EventV2Bridge.node,
        SessionProjector.node,
        CrossSpawnSpawner.node,
        InstanceStore.node,
        Question.node,
        httpClient,
        Truncate.node,
        Agent.node,
      ]),
      [
        [
          InstanceStore.bootstrapNode,
          Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
        ],
        [httpClient, FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>],
      ],
    ),
    loopbackServer,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({}),
  ),
)

const serve = Layer.mergeAll(
  HttpApiBuilder.layer(PermissionApi).pipe(Layer.provide(permissionHandlers as never)),
  HttpApiBuilder.layer(AutonomyApi).pipe(Layer.provide(autonomyHandlers as never)),
).pipe(
  Layer.provide([
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
    schemaErrorLayer,
    Layer.succeed(SessionPrompt.Service, SessionPrompt.Service.of({} as unknown as SessionPrompt.Interface)),
  ]),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

type Listed = { id: string; permission: string; metadata: Record<string, unknown>; deferred?: true }

const read = (url: string, directory: string) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("x-opencode-directory", directory), HttpClient.execute)

const listed = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* read("/permission", directory)
    expect(response.status).toBe(200)
    return (yield* response.json) as Listed[]
  })

/** The tool itself, so the prompt carries what the tool really puts in it rather than what a test thinks it does. */
const webfetch = (sessionID: SessionID, args: { url: string; format: "markdown" }) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const info = yield* WebFetchTool
    const tool = yield* info.init()
    return yield* tool.execute(args, {
      sessionID,
      messageID: MessageID.make("msg_message"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (request) => permission.ask({ ...request, sessionID, ruleset: [] }).pipe(Effect.orDie),
    })
  })

const untilListed = Effect.gen(function* () {
  const permission = yield* Permission.Service
  while ((yield* permission.list()).length === 0) yield* Effect.sleep("10 millis")
}).pipe(Effect.timeout("5 seconds"))

const URL_TO_FETCH = "https://example.invalid/page"

it.instance("a webfetch prompt with no timeout is listed, and can be answered from there", () =>
  Effect.gen(function* () {
    yield* serve
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const call = yield* webfetch(root.id, { url: URL_TO_FETCH, format: "markdown" }).pipe(Effect.exit, Effect.forkChild)
    yield* untilListed

    const [prompt] = yield* listed(test.directory)
    expect(prompt).toMatchObject({ permission: "webfetch", metadata: { url: URL_TO_FETCH, format: "markdown" } })
    expect(Object.keys(prompt!.metadata).sort()).toEqual(["format", "url"])

    const answered = yield* HttpClientRequest.post(`/permission/${prompt!.id}/reply`).pipe(
      HttpClientRequest.setHeader("x-opencode-directory", test.directory),
      HttpClientRequest.bodyJson({ reply: "reject" }),
      Effect.flatMap(HttpClient.execute),
    )
    expect(answered.status).toBe(200)
    expect(Exit.isFailure(yield* Fiber.join(call))).toBe(true)
    expect(yield* listed(test.directory)).toEqual([])
  }),
)

it.instance("one such prompt leaves the others in the folder listed", () =>
  Effect.gen(function* () {
    yield* serve
    const test = yield* TestInstance
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const first = yield* sessions.create({})
    const second = yield* sessions.create({})
    const bash = yield* permission
      .ask({
        sessionID: first.id,
        permission: "bash",
        patterns: ["ls"],
        metadata: { command: "ls" },
        always: [],
        ruleset: [],
      })
      .pipe(Effect.exit, Effect.forkChild)
    yield* untilListed
    const fetching = yield* webfetch(second.id, { url: URL_TO_FETCH, format: "markdown" }).pipe(
      Effect.exit,
      Effect.forkChild,
    )
    while ((yield* permission.list()).length < 2) yield* Effect.sleep("10 millis")

    expect((yield* listed(test.directory)).map((item) => item.permission).sort()).toEqual(["bash", "webfetch"])
    yield* Fiber.interrupt(bash)
    yield* Fiber.interrupt(fetching)
  }),
)

it.instance("a webfetch held by autonomous mode is listed beside its session's queue", () =>
  Effect.gen(function* () {
    yield* serve
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true })

    expect(Exit.isFailure(yield* webfetch(root.id, { url: URL_TO_FETCH, format: "markdown" }).pipe(Effect.exit))).toBe(
      true,
    )

    const [held] = yield* listed(test.directory)
    expect(held).toMatchObject({ permission: "webfetch", deferred: true })
    const queue = yield* read(AutonomyPaths.session.replace(":sessionID", root.id), test.directory)
    expect(queue.status).toBe(200)
    expect(yield* queue.json).toMatchObject({ rootID: root.id, open: 1 })
  }),
)

it.instance("metadata a plugin filled with what JSON cannot say does not take the list down", () =>
  Effect.gen(function* () {
    yield* serve
    const test = yield* TestInstance
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const ask = (metadata: Record<string, unknown>) =>
      permission
        .ask({ sessionID: root.id, permission: "plugin", patterns: ["*"], metadata, always: [], ruleset: [] })
        .pipe(Effect.exit, Effect.forkChild)

    const nested = yield* ask({ keep: "yes", nested: { gone: undefined }, list: [undefined], number: Number.NaN })
    const cannot = yield* ask({ big: 1n })
    while ((yield* permission.list()).length < 2) yield* Effect.sleep("10 millis")

    const items = yield* listed(test.directory)
    expect(items.map((item) => item.metadata)).toEqual([
      { keep: "yes", nested: {}, list: [null], number: null },
      {},
    ])
    yield* Fiber.interrupt(nested)
    yield* Fiber.interrupt(cannot)
  }),
)
