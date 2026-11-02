// The list version an answer was given at, through both routes the app can answer on (U11 E3, row 122b): a click on
// an entry that has grown since is shown again, and only the version that was shown lets the list through.

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { PermissionApi } from "../../src/server/routes/instance/httpapi/groups/permission"
import { SessionApi } from "../../src/server/routes/instance/httpapi/groups/session"
import { permissionHandlers } from "../../src/server/routes/instance/httpapi/handlers/permission"
import { sessionHandlers } from "../../src/server/routes/instance/httpapi/handlers/session"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { ServerAuth } from "../../src/server/auth"
import { SessionShare } from "../../src/share/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Todo } from "../../src/session/todo"
import { TestInstance } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const clean = () => rmSync(folder, { recursive: true, force: true })
const sent: string[] = []
beforeEach(() => {
  clean()
  sent.length = 0
})
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
      ]),
      [
        [
          InstanceStore.bootstrapNode,
          Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
        ],
      ],
    ),
    NodeHttpServer.layerTest,
    NodeServices.layer,
    workspaceLayerWithRuntimeFlags({}),
  ),
)

const prompt = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    prompt: (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        sent.push(input.sessionID)
        return {} as never
      }),
  } as unknown as SessionPrompt.Interface),
)
// The session group asks for these when it is built; the answer route uses none of them.
const unused = [
  SessionShare.Service,
  SessionRevert.Service,
  SessionCompaction.Service,
  SessionRunState.Service,
  SessionStatus.Service,
  Todo.Service,
  SessionSummary.Service,
  Agent.Service,
].map((tag) => Layer.succeed(tag as never, {} as never))

const middleware = [
  authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
  workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  instanceContextLayer,
  schemaErrorLayer,
  prompt,
]
const servePermission = HttpApiBuilder.layer(PermissionApi).pipe(
  Layer.provide(permissionHandlers as never),
  Layer.provide(middleware as never),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>
const serveSession = HttpApiBuilder.layer(SessionApi).pipe(
  Layer.provide(sessionHandlers as never),
  Layer.provide([...middleware, ...unused] as never),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

const command = "git push origin main"
/** Calls held in a mode-on family under one permission and pattern: one entry whose list is `count` long. */
const holdList = (count: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const permission = yield* Permission.Service
    const test = yield* TestInstance
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
    for (let index = 0; index < count; index++) {
      const exit = yield* permission
        .ask({
          sessionID: index % 2 ? child.id : root.id,
          permission: "bash",
          patterns: [command],
          metadata: { command, workdir: test.directory },
          always: ["*"],
          ruleset: [],
          canUndo: true,
          call: { tool: "bash", args: { command, workdir: test.directory, description: `push ${index}` } },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeferredError)
    }
    const entries = yield* permission.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.metadata.version).toBe(count > 1 ? count : undefined)
    return { root, entry: entries[0]!, directory: test.directory }
  })

const post = (url: string, directory: string, body: unknown) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("x-opencode-directory", directory),
      HttpClientRequest.bodyJson(body),
    )
    return (yield* HttpClient.execute(request)).status
  })
const viaPermission = (id: string, directory: string, reply: PermissionV1.Reply, version?: unknown) =>
  post(`/permission/${id}/reply`, directory, { reply, ...(version !== undefined && { version }) })
const viaSession = (sessionID: string, id: string, directory: string, reply: PermissionV1.Reply, version?: unknown) =>
  post(`/session/${sessionID}/permissions/${id}`, directory, {
    response: reply,
    ...(version !== undefined && { version }),
  })

const pending = Effect.gen(function* () {
  return (yield* (yield* Permission.Service).list()).map((item) => item.id)
})
const woken = Effect.gen(function* () {
  while (sent.length === 0) yield* Effect.sleep("10 millis")
}).pipe(Effect.timeout("2 seconds"))

it.instance("122b /permission reply: only the version shown lets a grown list through", () =>
  Effect.gen(function* () {
    yield* servePermission
    const { root, entry, directory } = yield* holdList(3)
    // No version is version 1, and 2 is a list that has grown since: both are shown again and nothing moves.
    for (const version of [undefined, 1, 2]) {
      expect(yield* viaPermission(entry.id, directory, "once", version)).toBe(200)
      expect(yield* pending).toEqual([entry.id])
    }
    yield* Effect.sleep("100 millis")
    expect(sent).toEqual([])
    expect(yield* viaPermission(entry.id, directory, "once", 3)).toBe(200)
    expect(yield* pending).toEqual([])
    yield* woken
    expect(sent).toEqual([root.id])
  }),
)

it.instance("122b /permission reply: a single call without a version is answered as before", () =>
  Effect.gen(function* () {
    yield* servePermission
    const { root, entry, directory } = yield* holdList(1)
    expect(yield* viaPermission(entry.id, directory, "once")).toBe(200)
    expect(yield* pending).toEqual([])
    yield* woken
    expect(sent).toEqual([root.id])
  }),
)

it.instance("122b /permission reply: a rejection settles the list whatever version it names", () =>
  Effect.gen(function* () {
    yield* servePermission
    const { entry, directory } = yield* holdList(2)
    expect(yield* viaPermission(entry.id, directory, "reject", 1)).toBe(200)
    expect(yield* pending).toEqual([])
  }),
)

it.instance("122b /permission reply: a version that is not a positive whole number is refused", () =>
  Effect.gen(function* () {
    yield* servePermission
    const { entry, directory } = yield* holdList(2)
    for (const version of [0, -1, 1.5, "2"])
      expect(yield* viaPermission(entry.id, directory, "once", version)).toBe(400)
    expect(yield* pending).toEqual([entry.id])
  }),
)

it.instance("122b /session permissions: the version reaches reply on the older route too", () =>
  Effect.gen(function* () {
    yield* serveSession
    const { root, entry, directory } = yield* holdList(2)
    expect(yield* viaSession(root.id, entry.id, directory, "once")).toBe(200)
    expect(yield* viaSession(root.id, entry.id, directory, "always", 1)).toBe(200)
    expect(yield* pending).toEqual([entry.id])
    expect(yield* viaSession(root.id, entry.id, directory, "once", "2")).toBe(400)
    expect(yield* pending).toEqual([entry.id])
    expect(yield* viaSession(root.id, entry.id, directory, "once", 2)).toBe(200)
    expect(yield* pending).toEqual([])
    yield* woken
    expect(sent).toEqual([root.id])
  }),
)
