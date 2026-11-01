// A person's answer on a held call, through the real route: the handler is what decides whether the agent hears about it.

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
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { PermissionApi } from "../../src/server/routes/instance/httpapi/groups/permission"
import { permissionHandlers } from "../../src/server/routes/instance/httpapi/handlers/permission"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { ServerAuth } from "../../src/server/auth"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { TestInstance } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const clean = () => rmSync(folder, { recursive: true, force: true })
const sent: { sessionID: string; text: string; lateAnswer: boolean }[] = []
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
        const part = input.parts[0] as { text: string; metadata?: { lateAnswer?: boolean } }
        sent.push({ sessionID: input.sessionID, text: part.text, lateAnswer: part.metadata?.lateAnswer === true })
        return {} as never
      }),
  } as unknown as SessionPrompt.Interface),
)

// The route the app serves, with one group mounted: the rest of the API has nothing to say about this.
const serve = HttpApiBuilder.layer(PermissionApi).pipe(
  Layer.provide(permissionHandlers as never),
  Layer.provide([
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
    schemaErrorLayer,
    prompt,
  ]),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

/** One call held in a mode-on root, by its child. */
const hold = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const autonomy = yield* Autonomy.Service
  const permission = yield* Permission.Service
  const test = yield* TestInstance
  const root = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: root.id })
  yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
  const command = "git push origin main"
  const exit = yield* permission
    .ask({
      sessionID: child.id,
      permission: "bash",
      patterns: [command],
      metadata: { command, workdir: test.directory },
      always: ["*"],
      ruleset: [],
      canUndo: true,
    })
    .pipe(Effect.exit)
  if (!Exit.isFailure(exit)) throw new Error("expected the call to be held")
  expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeferredError)
  const [held] = yield* permission.list()
  return { root, held: held!, directory: test.directory }
})

const answer = (requestID: string, directory: string, body: { reply: PermissionV1.Reply; message?: string }) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(`/permission/${requestID}/reply`).pipe(
      HttpClientRequest.setHeader("x-opencode-directory", directory),
      HttpClientRequest.bodyJson(body),
    )
    const response = yield* HttpClient.execute(request)
    expect(response.status).toBe(200)
  })

const delivered = (count: number) =>
  Effect.gen(function* () {
    while (sent.length < count) yield* Effect.sleep("10 millis")
  }).pipe(Effect.timeout("2 seconds"))

it.instance("AU-23 over HTTP: a no with a message reaches the root as a late answer", () =>
  Effect.gen(function* () {
    yield* serve
    const { root, held, directory } = yield* hold
    yield* answer(held.id, directory, { reply: "reject", message: "push to the fork instead" })
    yield* delivered(1)
    expect(sent[0]).toMatchObject({ sessionID: root.id, lateAnswer: true })
    expect(sent[0]!.text).toContain("push to the fork instead")
    expect(yield* (yield* Permission.Service).list()).toEqual([])
  }),
)

it.instance("AU-23 over HTTP: a plain no wakes nothing", () =>
  Effect.gen(function* () {
    yield* serve
    const { held, directory } = yield* hold
    yield* answer(held.id, directory, { reply: "reject" })
    yield* Effect.sleep("100 millis")
    expect(sent).toEqual([])
    expect(yield* (yield* Permission.Service).list()).toEqual([])
  }),
)

it.instance("AU-23 over HTTP: allow still wakes the root", () =>
  Effect.gen(function* () {
    yield* serve
    const { root, held, directory } = yield* hold
    yield* answer(held.id, directory, { reply: "once" })
    yield* delivered(1)
    expect(sent[0]).toMatchObject({ sessionID: root.id, lateAnswer: true })
    expect(sent[0]!.text).toContain("git push origin main")
  }),
)
