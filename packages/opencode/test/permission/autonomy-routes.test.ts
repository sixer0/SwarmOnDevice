// The routes that turn autonomous mode on and off. Two trees on purpose: one mounts only this group beside a real gate
// with a stub decider, and the other is the route tree production serves, because a service that is not wired there
// passes everything else.

import { NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Cause, Config, ConfigProvider, Effect, Exit, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { loopbackServer } from "./loopback-server"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventManifest } from "../../src/event-manifest"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { AutonomyApi } from "../../src/server/routes/instance/httpapi/groups/autonomy"
import { EventApi } from "../../src/server/routes/instance/httpapi/groups/event"
import { autonomyHandlers } from "../../src/server/routes/instance/httpapi/handlers/autonomy"
import { eventHandlers } from "../../src/server/routes/instance/httpapi/handlers/event"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Archive } from "../../src/tool/archive"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, requireInstance, TestInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const modeFile = path.join(folder, "mode.json")
const trustFile = path.join(Global.Path.state, "trust.json")
const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(trustFile, { force: true })
}
beforeEach(clean)
afterEach(clean)

type Mode = { on: boolean; externalChange: string[] }
type SessionState = Mode & {
  rootID: string
  open: number
  lines: { type: string; marker?: string; class?: string; requestID?: string }[]
  intact: boolean
  problems: string[]
  notFromHere: number
}

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

// A decider that lets everything through: the whole claim is that nobody but it answers.
const decided: string[] = []
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input) =>
      Effect.sync(() => {
        decided.push(input.patterns.join(" "))
        return { decision: "allow" as const, decidedBy: "agent:test/stub" }
      }),
  }),
)
beforeEach(() => {
  decided.length = 0
})

const gated = testEffect(
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
        // In this one graph: a second graph would bring its own gate with the real decider behind it.
        Workspace.node,
        EventV2.node,
      ]),
      [
        [InstanceStore.bootstrapNode, noopBootstrap],
        [Permission.deciderNode, decider],
        [RuntimeFlags.node, RuntimeFlags.layer({})],
      ],
    ),
    loopbackServer,
    NodeServices.layer,
  ),
)

const serveGroup = HttpApiBuilder.layer(AutonomyApi).pipe(
  Layer.provide(autonomyHandlers as never),
  Layer.provide([
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
    schemaErrorLayer,
  ]),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

const serveEvents = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers as never),
  Layer.provide([
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
  ]),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

const served: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})

const full = testEffect(
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Effect.promise(() => resetDatabase())
        yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
      }),
    ),
    served.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(loopbackServer),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const withWorkspace = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Workspace.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      InstanceStore.node,
      Ripgrep.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: true })],
      [InstanceStore.bootstrapNode, noopBootstrap],
    ],
  ),
)

const call = (method: "GET" | "PUT" | "POST", url: string, directory: string, body?: unknown) =>
  Effect.gen(function* () {
    const base =
      method === "GET"
        ? HttpClientRequest.get(url)
        : method === "PUT"
          ? HttpClientRequest.put(url)
          : HttpClientRequest.post(url)
    const headed = base.pipe(HttpClientRequest.setHeader("x-opencode-directory", directory))
    const request = body === undefined ? headed : yield* HttpClientRequest.bodyJson(headed, body)
    return yield* HttpClient.execute(request)
  })

const ok = <T>(method: "GET" | "PUT" | "POST", url: string, directory: string, body?: unknown) =>
  Effect.gen(function* () {
    const response = yield* call(method, url, directory, body)
    expect(response.status).toBe(200)
    return (yield* response.json) as T
  })

const putMode = (
  directory: string,
  body: { on: boolean; sessionID?: string; bypassConsent?: string; reportLanguage?: string },
) =>
  ok<Mode>("PUT", "/autonomy/mode", directory, body)
const getFolder = (directory: string) => ok<Mode>("GET", "/autonomy/mode", directory)
const getSession = (id: string, directory: string) => ok<SessionState>("GET", `/session/${id}/autonomy`, directory)
const createSession = (directory: string, body: { parentID?: string } = {}) =>
  ok<{ id: string }>("POST", "/session", directory, body)

const markers = (state: SessionState) => state.lines.flatMap((line) => (line.marker ? [line.marker] : []))
const savedMode = () => JSON.parse(readFileSync(modeFile, "utf8")) as { sessions: object; directories: object }

const bash = (sessionID: SessionID, command: string, directory: string) =>
  ({
    sessionID,
    permission: "bash",
    patterns: [command],
    metadata: { command, workdir: directory },
    always: ["*"],
    ruleset: [],
    canUndo: true,
  }) satisfies PermissionV1.AskInput

const held = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* permission.ask(input).pipe(Effect.timeout("2 seconds"), Effect.exit)
    if (!Exit.isFailure(exit)) throw new Error("expected the call to be held")
    return Cause.squash(exit.cause)
  })

const ran = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask(input).pipe(Effect.timeout("2 seconds"))
  })

gated.instance("AU-15: with no client connected, P runs and D is held, after one call to the route", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const root = yield* sessions.create({})

    yield* putMode(test.directory, { on: true, sessionID: root.id })

    // No event stream, no reply route and no renderer exist in this tree: the only way past is the gate itself.
    yield* ran(bash(root.id, "bun test a.test.ts", test.directory))
    expect(decided).toEqual(["bun test a.test.ts"])
    expect(yield* held(bash(root.id, "git push origin main", test.directory))).toBeInstanceOf(
      PermissionV1.DeferredError,
    )
    expect(decided).toEqual(["bun test a.test.ts"])
    expect((yield* permission.list()).map((item) => item.patterns)).toEqual([["git push origin main"]])
  }),
)

gated.instance("AU-15: a folder turned on carries a session that starts later, with no client", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    yield* putMode(test.directory, { on: true })
    const root = yield* sessions.create({})
    yield* ran(bash(root.id, "bun test a.test.ts", test.directory))
    expect(decided).toEqual(["bun test a.test.ts"])
  }),
)

gated.instance("AU-15: turning the mode on or off keeps the instance and what it holds", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const root = yield* sessions.create({})
    yield* putMode(test.directory, { on: true, sessionID: root.id })
    yield* held(bash(root.id, "git push origin main", test.directory))
    yield* putMode(test.directory, { on: false, sessionID: root.id })
    yield* putMode(test.directory, { on: true })
    expect((yield* permission.list()).length).toBe(1)
  }),
)

gated.instance("S-3: a change from outside holds P until a person confirms it", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    yield* putMode(test.directory, { on: true, sessionID: root.id })

    const changed = JSON.stringify({ v: 1, sessions: { [root.id]: true }, directories: {} })
    writeFileSync(modeFile, changed)
    expect(yield* held(bash(root.id, "bun test a.test.ts", test.directory))).toBeInstanceOf(PermissionV1.DeferredError)
    expect(decided).toEqual([])
    expect((yield* getSession(root.id, test.directory)).externalChange).toEqual(["mode.json"])
    expect(markers(yield* getSession(root.id, test.directory))).toContain("external_change")

    expect((yield* ok<Mode>("POST", "/autonomy/confirm", test.directory)).externalChange).toEqual([])
    yield* ran(bash(root.id, "bun test b.test.ts", test.directory))
    expect(decided).toEqual(["bun test b.test.ts"])
  }),
)

gated.instance("S-3: what a file turned on from outside only counts after the confirmation", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    yield* putMode(test.directory, { on: false })
    writeFileSync(modeFile, JSON.stringify({ v: 1, sessions: {}, directories: { [test.directory]: true } }))
    expect((yield* getFolder(test.directory)).on).toBe(false)
    expect((yield* ok<Mode>("POST", "/autonomy/confirm", test.directory)).on).toBe(true)
  }),
)

gated.instance("the session route counts only its own root's open decisions, and reads the record", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    const other = yield* sessions.create({})
    yield* putMode(test.directory, { on: true, sessionID: root.id })
    yield* putMode(test.directory, { on: true, sessionID: other.id })
    yield* held(bash(child.id, "git push origin main", test.directory))
    yield* held(bash(child.id, "git push origin dev", test.directory))
    yield* held(bash(other.id, "git push origin main", test.directory))

    const state = yield* getSession(child.id, test.directory)
    expect(state).toMatchObject({ rootID: root.id, on: true, open: 2, intact: true, problems: [], notFromHere: 0 })
    expect(state.lines.filter((line) => line.type === "decision").map((line) => line.class)).toEqual(["D", "D"])
    expect((yield* getSession(other.id, test.directory)).open).toBe(1)
  }),
)

gated.instance("the session route says whether the bypass consent holds: no without it, yes with bypass-v1", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    yield* putMode(test.directory, { on: true, sessionID: root.id })
    expect(yield* getSession(root.id, test.directory)).toMatchObject({ on: true, bypass: false })

    yield* putMode(test.directory, { on: true, sessionID: root.id, bypassConsent: "bypass-v1", reportLanguage: "id" })
    expect(yield* getSession(root.id, test.directory)).toMatchObject({ on: true, bypass: true })
  }),
)

gated.instance("the session route says when the record has been changed", () =>
  Effect.gen(function* () {
    yield* serveGroup
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    yield* putMode(test.directory, { on: true, sessionID: root.id })
    expect((yield* getSession(root.id, test.directory)).intact).toBe(true)

    const record = path.join(folder, `${root.id}.jsonl`)
    writeFileSync(record, readFileSync(record, "utf8").replace("mode_on", "mode_off"))
    const state = yield* getSession(root.id, test.directory)
    expect(state.intact).toBe(false)
    expect(state.problems.length).toBeGreaterThan(0)
  }),
)

gated.instance(
  "a file that cannot be replaced: starting stays off, stopping still holds and is recorded, both say so",
  () =>
    Effect.gen(function* () {
      yield* serveGroup
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const root = yield* sessions.create({})
      yield* putMode(test.directory, { on: true, sessionID: root.id })
      rmSync(modeFile)
      mkdirSync(modeFile)

      const stopped = yield* call("PUT", "/autonomy/mode", test.directory, { on: false, sessionID: root.id })
      expect(stopped.status).toBe(500)
      expect(yield* stopped.json).toMatchObject({ name: "AutonomyWriteError", data: { message: expect.any(String) } })
      const state = yield* getSession(root.id, test.directory)
      expect(state.on).toBe(false)
      expect(markers(state)).toEqual(["mode_on", "mode_off"])

      const started = yield* call("PUT", "/autonomy/mode", test.directory, { on: true, sessionID: root.id })
      expect(started.status).toBe(500)
      expect((yield* getSession(root.id, test.directory)).on).toBe(false)

      const folderStarted = yield* call("PUT", "/autonomy/mode", test.directory, { on: true })
      expect(folderStarted.status).toBe(500)
      expect((yield* getFolder(test.directory)).on).toBe(false)
    }),
)

full.live(
  "the served tree: folder and session write mode.json, the session's value wins, the first answer is off",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      expect(yield* getFolder(directory)).toEqual({ on: false, externalChange: [], bypass: false } as Mode)
      expect(existsSync(modeFile)).toBe(false)

      const session = yield* createSession(directory)
      expect((yield* getSession(session.id, directory)).on).toBe(false)

      expect((yield* putMode(directory, { on: true })).on).toBe(true)
      expect(yield* getFolder(directory)).toEqual({ on: true, externalChange: [], bypass: false } as Mode)
      expect(savedMode()).toEqual({ v: 1, sessions: {}, directories: { [directory]: true } } as never)
      expect((yield* getSession(session.id, directory)).on).toBe(true)

      expect((yield* putMode(directory, { on: false, sessionID: session.id })).on).toBe(false)
      expect((yield* getSession(session.id, directory)).on).toBe(false)
      expect((yield* getFolder(directory)).on).toBe(true)
      expect((yield* getSession((yield* createSession(directory)).id, directory)).on).toBe(true)

      expect((yield* putMode(directory, { on: false })).on).toBe(false)
      expect(savedMode()).toMatchObject({ sessions: { [session.id]: false }, directories: {} })
    }),
)

full.live("the served tree: a subagent's session changes and reads its root, and the record notes each change", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const root = yield* createSession(directory)
    const child = yield* createSession(directory, { parentID: root.id })
    const grandchild = yield* createSession(directory, { parentID: child.id })

    yield* putMode(directory, { on: true, sessionID: grandchild.id })
    expect(savedMode().sessions).toEqual({ [root.id]: true })
    let state = yield* getSession(grandchild.id, directory)
    expect(state).toMatchObject({ rootID: root.id, on: true, intact: true })
    expect(markers(state)).toEqual(["mode_on"])

    // Saying the same thing twice is not a change.
    yield* putMode(directory, { on: true, sessionID: root.id })
    expect(markers(yield* getSession(root.id, directory))).toEqual(["mode_on"])

    yield* putMode(directory, { on: false, sessionID: child.id })
    state = yield* getSession(root.id, directory)
    expect(markers(state)).toEqual(["mode_on", "mode_off"])
    expect(state.intact).toBe(true)
  }),
)

full.live("the served tree: no such session is a 404 and saves nothing, and a malformed body is a 400", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const missing = "ses_doesnotexist"
    expect((yield* call("GET", `/session/${missing}/autonomy`, directory)).status).toBe(404)
    expect((yield* call("PUT", "/autonomy/mode", directory, { on: true, sessionID: missing })).status).toBe(404)
    expect((yield* call("PUT", "/autonomy/mode", directory, { on: "yes" })).status).toBe(400)
    expect((yield* call("PUT", "/autonomy/mode", directory, {})).status).toBe(400)
    expect(existsSync(modeFile)).toBe(false)
  }),
)

full.live("the served tree: trust through the app reads as no change from outside, and trust around it does", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const other = yield* tmpdirScoped({ git: true })
    const decide = yield* call("POST", "/project/trust", directory, { decision: "trust" })
    expect(decide.status).toBe(200)
    expect(readFileSync(trustFile, "utf8")).toContain(ProjectTrust.rootOf(directory))

    // Setting a mode is what looks at the files again.
    const after = yield* putMode(directory, { on: true })
    expect(after.externalChange).toEqual([])

    ProjectTrust.trust(other)
    expect((yield* putMode(directory, { on: true })).externalChange).toEqual(["trust.json"])
    expect((yield* ok<Mode>("POST", "/autonomy/confirm", directory)).externalChange).toEqual([])
  }),
)

test("the served tree: changing the mode disposes nothing, where deciding trust does", async () => {
  await using tmp = await tmpdir({ git: true })
  const disposed: GlobalEvent[] = []
  const listener = (event: GlobalEvent) => {
    if (event.payload?.type === "server.instance.disposed" && event.directory === tmp.path) disposed.push(event)
  }
  GlobalBus.on("event", listener)
  // The server that tears instances down: the teardown is middleware outside the route tree.
  const send = (method: string, url: string, body?: unknown) =>
    Server.Default().app.fetch(
      new Request(new URL(url, "http://localhost"), {
        method,
        headers: { "x-opencode-directory": tmp.path, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  try {
    expect((await send("GET", "/autonomy/mode")).status).toBe(200)
    expect((await send("PUT", "/autonomy/mode", { on: true })).status).toBe(200)
    expect((await send("PUT", "/autonomy/mode", { on: false })).status).toBe(200)
    expect((await send("POST", "/autonomy/confirm")).status).toBe(200)
    await Bun.sleep(100)
    expect(disposed).toEqual([])

    expect((await send("POST", "/project/trust", { decision: "trust" })).status).toBe(200)
    for (let index = 0; disposed.length === 0 && index < 200; index++) await Bun.sleep(10)
    expect(disposed.length).toBeGreaterThan(0)
  } finally {
    GlobalBus.off("event", listener)
    await disposeAllInstances()
    await resetDatabase()
  }
})

test("the served tree: no password, no change to the mode and nothing to read", async () => {
  await using tmp = await tmpdir({ git: true })
  const password = "route-test-only"
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: password }))),
    ),
    { disableLogger: true },
  ).handler
  const send = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
    handler(
      new Request(new URL(url, "http://localhost"), {
        method,
        headers: { "x-opencode-directory": tmp.path, "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      HttpApiApp.context,
    )
  try {
    expect((await send("PUT", "/autonomy/mode", {}, { on: true })).status).toBe(401)
    expect((await send("POST", "/autonomy/confirm")).status).toBe(401)
    expect((await send("GET", "/autonomy/mode")).status).toBe(401)
    expect((await send("GET", "/session/ses_doesnotexist/autonomy")).status).toBe(401)
    expect(existsSync(modeFile)).toBe(false)

    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    expect((await send("PUT", "/autonomy/mode", { authorization }, { on: true })).status).toBe(200)
    expect(existsSync(modeFile)).toBe(true)
  } finally {
    await disposeAllInstances()
    await resetDatabase()
  }
})

gated.instance(
  "autonomy.blocked reaches a client over the event route, in this folder, with only its three fields",
  () =>
    Effect.gen(function* () {
      yield* serveEvents
      const test = yield* TestInstance
      const events = yield* EventV2.Service
      const response = yield* call("GET", "/event", test.directory)
      expect(response.status).toBe(200)
      const seen = yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.tap((text) =>
          text.includes("server.connected")
            ? events.publish(
                Autonomy.Blocked,
                { sessionID: "ses_blocked", level: "b1", count: 2 },
                { location: { directory: AbsolutePath.make(test.directory) } },
              )
            : Effect.void,
        ),
        Stream.filter((text) => text.includes("autonomy.blocked")),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("3 seconds"),
      )
      const frame = JSON.parse(Array.from(seen)[0]!.split("data: ")[1]!) as { type: string; properties: object }
      expect(frame.type).toBe("autonomy.blocked")
      expect(frame.properties).toEqual({ sessionID: "ses_blocked", level: "b1", count: 2 })
    }),
)

test("autonomy.blocked is in the contract clients are generated from", () => {
  expect(EventManifest.Latest.get(Autonomy.Blocked.type)?.type).toBe("autonomy.blocked")
  const types = readFileSync(new URL("../../../sdk/js/src/v2/gen/types.gen.ts", import.meta.url), "utf8")
  const generated = types.slice(types.indexOf("export type EventAutonomyBlocked"))
  expect(generated.slice(0, generated.indexOf("\n}\n"))).toContain('type: "autonomy.blocked"')
  expect(types).toMatch(/level: "b0" \| "b1"/)
})

test("the generated client has the routes", () => {
  const sdk = readFileSync(new URL("../../../sdk/js/src/v2/gen/sdk.gen.ts", import.meta.url), "utf8")
  for (const route of ["/autonomy/mode", "/autonomy/confirm", "/session/{sessionID}/autonomy"])
    expect(sdk).toContain(`url: "${route}"`)
})

// Row 132: the person's route to the consent list. Its group is served here with a password the shell never sees.
const PASSWORD = "consent-route-test-only"
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`

const serveGroupWith = (password: string | undefined) =>
  HttpApiBuilder.layer(AutonomyApi).pipe(
    Layer.provide(autonomyHandlers as never),
    Layer.provide([
      authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
      workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
      instanceContextLayer,
      schemaErrorLayer,
    ]),
    HttpRouter.serve,
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown(password ? { OPENCODE_SERVER_PASSWORD: password } : {})),
    ),
    Layer.build,
  ) as unknown as Effect.Effect<unknown>

type ConsentState = {
  rootID: string
  consent: null | {
    id: string
    hash: string
    at: number
    items: {
      id: string
      kind: string
      pattern: string
      files: string[]
      named: boolean
      checked: boolean
      given: boolean
    }[]
    dropped: number
  }
}

const send = (
  method: "GET" | "PUT" | "POST",
  url: string,
  directory: string,
  options: { body?: unknown; authorized?: boolean } = {},
) =>
  Effect.gen(function* () {
    const base =
      method === "GET"
        ? HttpClientRequest.get(url)
        : method === "PUT"
          ? HttpClientRequest.put(url)
          : HttpClientRequest.post(url)
    const directed = base.pipe(HttpClientRequest.setHeader("x-opencode-directory", directory))
    const headed = options.authorized
      ? directed.pipe(HttpClientRequest.setHeader("authorization", AUTHORIZATION))
      : directed
    const request = options.body === undefined ? headed : yield* HttpClientRequest.bodyJson(headed, options.body)
    return yield* HttpClient.execute(request)
  })

const say = Effect.fn("AutonomyRoutesTest.say")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const message = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID, type: "text", text })
})

// A root with a person's message naming one secret file, switched on through the route as the `+` menu does.
const missionWithSecret = Effect.fn("AutonomyRoutesTest.missionWithSecret")(function* (authorized: boolean) {
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  const root = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: root.id })
  writeFileSync(path.join(test.directory, ".env"), "TOKEN=not-read\n")
  yield* say(root.id, "Perbaiki konfigurasi di .env lalu jalankan uji.")
  const switched = yield* send("PUT", "/autonomy/mode", test.directory, {
    body: { on: true, sessionID: root.id },
    authorized,
  })
  expect(switched.status).toBe(200)
  return { directory: test.directory, root, child }
})

const consentAt = (sessionID: string) => `/session/${sessionID}/autonomy/consent`

const readConsent = (sessionID: string, directory: string, authorized: boolean) =>
  Effect.gen(function* () {
    const response = yield* send("GET", consentAt(sessionID), directory, { authorized })
    expect(response.status).toBe(200)
    return (yield* response.json) as ConsentState
  })

const recordOf = (root: string) =>
  readFileSync(path.join(folder, `${root}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

gated.instance("row 132: a person with the password reads the list and allows an item, and it is recorded", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const autonomy = yield* Autonomy.Service
    const { directory, root, child } = yield* missionWithSecret(true)

    // A subagent's session answers with its root's list.
    const shown = yield* readConsent(child.id, directory, true)
    expect(shown.rootID).toBe(root.id)
    expect(shown.consent?.items.map((item) => [item.kind, item.pattern, item.named, item.checked, item.given])).toEqual(
      [["secret", ".env*", true, true, false]],
    )
    expect(shown.consent?.items[0]?.files).toEqual([path.join(directory, ".env")])
    const list = shown.consent!

    const allowed = yield* send("POST", consentAt(child.id), directory, {
      body: { hash: list.hash, ids: [list.items[0]!.id] },
      authorized: true,
    })
    expect(allowed.status).toBe(200)
    const after = (yield* allowed.json) as ConsentState
    expect(after.consent?.items.map((item) => item.given)).toEqual([true])
    expect((yield* readConsent(root.id, directory, true)).consent?.items[0]?.given).toBe(true)
    expect([...(yield* autonomy.consent(root.id))!.given]).toEqual([list.items[0]!.id])

    const lines = recordOf(root.id)
    expect(
      lines
        .filter((line) => line.permission === "autonomy_consent")
        .map((line) => [line.type, line.class, line.category, line.decidedBy, line.consentID]),
    ).toEqual([["decision", "A", "consented", "person", list.items[0]!.id]])
    expect(lines.filter((line) => line.marker === "consent_given").map((line) => line.hash)).toEqual([list.hash])
    // Names only, through the route as well.
    expect(JSON.stringify(after)).not.toContain("not-read")
  }),
)

gated.instance("row 132: without the password nothing is read or allowed, and nothing is recorded", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const autonomy = yield* Autonomy.Service
    const { directory, root } = yield* missionWithSecret(true)
    const list = (yield* autonomy.consent(root.id))!
    const body = { hash: list.hash, ids: list.items.map((item) => item.id) }

    expect((yield* send("GET", consentAt(root.id), directory)).status).toBe(401)
    expect((yield* send("POST", consentAt(root.id), directory, { body })).status).toBe(401)
    const forged = yield* send(
      "POST",
      `${consentAt(root.id)}?auth_token=${Buffer.from("opencode:guess").toString("base64")}`,
      directory,
      { body },
    )
    expect(forged.status).toBe(401)

    expect((yield* autonomy.consent(root.id))!.given.size).toBe(0)
    expect(recordOf(root.id).filter((line) => line.permission === "autonomy_consent")).toEqual([])
    expect(recordOf(root.id).some((line) => line.marker === "consent_given")).toBe(false)
  }),
)

gated.instance("row 132: a server with no password takes no consent at all, and still shows the list", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(undefined)
    const autonomy = yield* Autonomy.Service
    const { directory, root } = yield* missionWithSecret(false)
    const list = (yield* readConsent(root.id, directory, false)).consent!
    expect(list.items.length).toBe(1)

    const refused = yield* send("POST", consentAt(root.id), directory, {
      body: { hash: list.hash, ids: [list.items[0]!.id] },
    })
    expect(refused.status).toBe(403)
    expect(yield* refused.json).toMatchObject({
      name: "AutonomyNoPasswordError",
      data: { message: expect.any(String) },
    })
    expect((yield* autonomy.consent(root.id))!.given.size).toBe(0)
    expect(recordOf(root.id).filter((line) => line.permission === "autonomy_consent")).toEqual([])
  }),
)

gated.instance("row 132: only the list on show can be answered, and an id not on it allows nothing", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const autonomy = yield* Autonomy.Service
    const { directory, root } = yield* missionWithSecret(true)
    const list = (yield* readConsent(root.id, directory, true)).consent!

    const stale = yield* send("POST", consentAt(root.id), directory, {
      body: { hash: "0".repeat(64), ids: [list.items[0]!.id] },
      authorized: true,
    })
    expect(stale.status).toBe(409)
    expect(yield* stale.json).toMatchObject({ name: "AutonomyConsentError", data: { message: expect.any(String) } })

    const foreign = yield* send("POST", consentAt(root.id), directory, {
      body: { hash: list.hash, ids: ["secret:made-up", "destination:github:000000000000"] },
      authorized: true,
    })
    expect(foreign.status).toBe(200)
    expect(((yield* foreign.json) as ConsentState).consent?.items.map((item) => item.given)).toEqual([false])
    expect((yield* autonomy.consent(root.id))!.given.size).toBe(0)

    // Off takes the list: an answer to it after that is a conflict, and the route reads null.
    expect(
      (yield* send("PUT", "/autonomy/mode", directory, { body: { on: false, sessionID: root.id }, authorized: true }))
        .status,
    ).toBe(200)
    expect((yield* readConsent(root.id, directory, true)).consent).toBeNull()
    const late = yield* send("POST", consentAt(root.id), directory, {
      body: { hash: list.hash, ids: [list.items[0]!.id] },
      authorized: true,
    })
    expect(late.status).toBe(409)
  }),
)

gated.instance("row 132: no mission yet reads null; no such session is a 404; a malformed answer is a 400", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    expect(yield* readConsent(root.id, test.directory, true)).toEqual({ rootID: root.id, consent: null })

    const missing = "ses_doesnotexist"
    expect((yield* send("GET", consentAt(missing), test.directory, { authorized: true })).status).toBe(404)
    expect(
      (yield* send("POST", consentAt(missing), test.directory, { body: { hash: "a", ids: [] }, authorized: true }))
        .status,
    ).toBe(404)
    expect(
      (yield* send("POST", consentAt(root.id), test.directory, { body: { hash: "a" }, authorized: true })).status,
    ).toBe(400)
    expect(
      (yield* send("POST", consentAt(root.id), test.directory, { body: { hash: 1, ids: [] }, authorized: true }))
        .status,
    ).toBe(400)
  }),
)

test("row 132: no tool reaches allowConsent, only the password route does", async () => {
  const source = path.join(import.meta.dir, "../../src")
  const callers: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: source }))
    if (/\ballowConsent\b/.test(readFileSync(path.join(source, file), "utf8"))) callers.push(file)
  expect(callers.sort()).toEqual(["permission/autonomy.ts", "server/routes/instance/httpapi/handlers/autonomy.ts"])
})

// Row 152: the person's route to the archive. Same group, same password rule as consent.
type ArchiveState = {
  rootID: string
  entries: { id: string; bytes: number; count: number; paths: string[] }[]
  bytes: number
  unsafe: boolean
}

const archiveAt = (sessionID: string) => `/session/${sessionID}/autonomy/archive`
const emptyAt = (sessionID: string) => `/session/${sessionID}/autonomy/archive/empty`

const readArchive = (sessionID: string, directory: string, authorized: boolean) =>
  Effect.gen(function* () {
    const response = yield* send("GET", archiveAt(sessionID), directory, { authorized })
    expect(response.status).toBe(200)
    return (yield* response.json) as ArchiveState
  })

const markersOf = (root: string) =>
  existsSync(path.join(folder, `${root}.jsonl`))
    ? recordOf(root).filter((line) => line.marker === "archive_emptied")
    : []

// Two deletions moved into the archive as the shell does, one of them a link that points out of the folder.
const archived = Effect.fn("AutonomyRoutesTest.archived")(function* () {
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  const root = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: root.id })
  const outside = yield* tmpdirScoped()
  const target = path.join(outside, "keep.txt")
  writeFileSync(target, "outside\n")
  mkdirSync(path.join(test.directory, "build", "out"), { recursive: true })
  writeFileSync(path.join(test.directory, "build", "out", "a.js"), "12345")
  symlinkSync(target, path.join(test.directory, "link"))
  const first = yield* Effect.promise(() =>
    Archive.move({ directory: test.directory, paths: ["build"], now: new Date(2026, 10, 2, 9, 0, 0) }),
  )
  const second = yield* Effect.promise(() =>
    Archive.move({ directory: test.directory, paths: ["link"], now: new Date(2026, 10, 2, 9, 0, 1) }),
  )
  if (!first.ok || !second.ok) throw new Error("archive move failed")
  return { directory: test.directory, root, child, target, ids: [first.id, second.id] }
})

gated.instance("row 152: a person with the password sees the archive and empties it, and only the archive goes", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root, child, target, ids } = yield* archived()

    // A subagent's session answers with its root's folder.
    const shown = yield* readArchive(child.id, directory, true)
    expect(shown.rootID).toBe(root.id)
    expect(shown.unsafe).toBe(false)
    expect(shown.entries.map((entry) => [entry.id, entry.count, entry.paths])).toEqual([
      [ids[0], 1, ["build/out/a.js"]],
      [ids[1], 1, ["link"]],
    ])
    expect(shown.entries[0]!.bytes).toBe(5)
    expect(shown.bytes).toBeGreaterThanOrEqual(5)

    const emptied = yield* send("POST", emptyAt(child.id), directory, { body: { ids }, authorized: true })
    expect(emptied.status).toBe(200)
    expect(((yield* emptied.json) as ArchiveState).entries).toEqual([])
    for (const id of ids) expect(existsSync(path.join(directory, Archive.ARCHIVE_DIR, id))).toBe(false)
    // The link went as the link; what it pointed to, outside the folder, is still there.
    expect(readFileSync(target, "utf8")).toBe("outside\n")
    // The archive stays an ignored folder for the next move.
    expect(readFileSync(path.join(directory, Archive.ARCHIVE_DIR, ".gitignore"), "utf8")).toBe("*\n")
    expect(markersOf(root.id).map((line) => [line.type, line.decidedBy])).toEqual([["marker", "person"]])
  }),
)

gated.instance("row 152: only the entries named go, and nothing that is not an entry", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root, ids } = yield* archived()
    const stray = path.join(directory, Archive.ARCHIVE_DIR, "notes")
    mkdirSync(stray)

    const response = yield* send("POST", emptyAt(root.id), directory, {
      body: { ids: [ids[0], "..", "../..", "notes", ".gitignore", "20260101-000000-1", `${ids[1]}/..`] },
      authorized: true,
    })
    expect(response.status).toBe(200)
    expect(((yield* response.json) as ArchiveState).entries.map((entry) => entry.id)).toEqual([ids[1]])
    expect(existsSync(path.join(directory, Archive.ARCHIVE_DIR, ids[1]!))).toBe(true)
    expect(existsSync(stray)).toBe(true)
    expect(existsSync(path.join(directory, Archive.ARCHIVE_DIR, ".gitignore"))).toBe(true)
    expect(markersOf(root.id).length).toBe(1)

    // Nothing named that is on show: nothing deleted, nothing recorded.
    const none = yield* send("POST", emptyAt(root.id), directory, { body: { ids: [] }, authorized: true })
    expect(none.status).toBe(200)
    expect(markersOf(root.id).length).toBe(1)
  }),
)

gated.instance("row 152: without the password nothing is read or deleted, and nothing is recorded", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root, ids } = yield* archived()
    expect((yield* send("GET", archiveAt(root.id), directory)).status).toBe(401)
    expect((yield* send("POST", emptyAt(root.id), directory, { body: { ids } })).status).toBe(401)
    for (const id of ids) expect(existsSync(path.join(directory, Archive.ARCHIVE_DIR, id))).toBe(true)
    expect(markersOf(root.id)).toEqual([])
  }),
)

gated.instance("row 152: a server with no password shows the archive and refuses to empty it", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(undefined)
    const { directory, root, ids } = yield* archived()
    expect((yield* readArchive(root.id, directory, false)).entries.length).toBe(2)
    const refused = yield* send("POST", emptyAt(root.id), directory, { body: { ids } })
    expect(refused.status).toBe(403)
    expect(yield* refused.json).toMatchObject({
      name: "AutonomyNoPasswordError",
      data: { message: expect.any(String) },
    })
    for (const id of ids) expect(existsSync(path.join(directory, Archive.ARCHIVE_DIR, id))).toBe(true)
    expect(markersOf(root.id)).toEqual([])
  }),
)

gated.instance("row 152: an archive or an entry that is a link is not read or deleted through", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const outside = yield* tmpdirScoped()

    // An entry named like one, but a link to a folder outside.
    const elsewhere = path.join(outside, "elsewhere")
    mkdirSync(elsewhere)
    writeFileSync(path.join(elsewhere, "keep.txt"), "keep")
    const moved = yield* Effect.promise(() => Archive.move({ directory: test.directory, paths: [] }))
    expect(moved.ok).toBe(true)
    mkdirSync(path.join(test.directory, Archive.ARCHIVE_DIR), { recursive: true })
    symlinkSync(elsewhere, path.join(test.directory, Archive.ARCHIVE_DIR, "20261102-090000-1"))
    expect((yield* readArchive(root.id, test.directory, true)).entries).toEqual([])
    const linked = yield* send("POST", emptyAt(root.id), test.directory, {
      body: { ids: ["20261102-090000-1"] },
      authorized: true,
    })
    expect(linked.status).toBe(200)
    expect(readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toBe("keep")

    // The whole archive a link: shown as unsafe, nothing in it read or deleted.
    rmSync(path.join(test.directory, ".swarm"), { recursive: true, force: true })
    const fake = path.join(outside, "fake-archive")
    mkdirSync(path.join(fake, "20261102-090000-2"), { recursive: true })
    writeFileSync(path.join(fake, "20261102-090000-2", "keep.txt"), "keep")
    mkdirSync(path.join(test.directory, ".swarm"))
    symlinkSync(fake, path.join(test.directory, Archive.ARCHIVE_DIR))
    const unsafe = yield* readArchive(root.id, test.directory, true)
    expect([unsafe.unsafe, unsafe.entries]).toEqual([true, []])
    const refused = yield* send("POST", emptyAt(root.id), test.directory, {
      body: { ids: ["20261102-090000-2"] },
      authorized: true,
    })
    expect(refused.status).toBe(200)
    expect(readFileSync(path.join(fake, "20261102-090000-2", "keep.txt"), "utf8")).toBe("keep")
    expect(markersOf(root.id)).toEqual([])
  }),
)

gated.instance("row 152: no archive reads empty; no such session is a 404; a malformed answer is a 400", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    expect(yield* readArchive(root.id, test.directory, true)).toEqual({
      rootID: root.id,
      entries: [],
      bytes: 0,
      unsafe: false,
    })
    const missing = "ses_doesnotexist"
    expect((yield* send("GET", archiveAt(missing), test.directory, { authorized: true })).status).toBe(404)
    expect(
      (yield* send("POST", emptyAt(missing), test.directory, { body: { ids: [] }, authorized: true })).status,
    ).toBe(404)
    expect((yield* send("POST", emptyAt(root.id), test.directory, { body: {}, authorized: true })).status).toBe(400)
    expect(
      (yield* send("POST", emptyAt(root.id), test.directory, { body: { ids: "all" }, authorized: true })).status,
    ).toBe(400)
  }),
)

test("row 152: only the person's route records an emptied archive", async () => {
  const source = path.join(import.meta.dir, "../../src")
  const writers: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: source }))
    if (/marker: "archive_emptied"/.test(readFileSync(path.join(source, file), "utf8"))) writers.push(file)
  expect(writers).toEqual(["server/routes/instance/httpapi/handlers/autonomy.ts"])
})

withWorkspace.instance(
  "removing a workspace takes its root sessions' records and leaves every other root's",
  () =>
    Effect.gen(function* () {
      const test = yield* requireInstance
      const sessions = yield* Session.Service
      const workspace = yield* Workspace.Service
      const { db } = yield* Database.Service
      const id = WorkspaceV2.ID.ascending()
      const type = `manual-${id}`
      yield* db
        .insert(WorkspaceTable)
        .values({
          id,
          type,
          branch: null,
          name: "autonomy",
          directory: test.directory,
          extra: null,
          project_id: test.project.id,
          time_used: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      const inside = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: inside.id })
      const outside = yield* sessions.create({})
      yield* db
        .update(SessionTable)
        .set({ workspace_id: id })
        .where(eq(SessionTable.id, inside.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ workspace_id: id })
        .where(eq(SessionTable.id, child.id))
        .run()
        .pipe(Effect.orDie)

      const record = (name: string) => path.join(folder, `${name}.jsonl`)
      yield* Effect.sync(() => {
        rmSync(folder, { recursive: true, force: true })
        mkdirSync(folder, { recursive: true })
        writeFileSync(record(inside.id), "{}\n")
        writeFileSync(record(outside.id), "{}\n")
      })

      yield* workspace.remove(id)

      expect(existsSync(record(inside.id))).toBe(false)
      expect(existsSync(record(outside.id))).toBe(true)
    }),
  { git: true },
)
