// The routes that turn autonomous mode on and off. Two trees on purpose: one mounts only this group beside a real gate
// with a stub decider, and the other is the route tree production serves, because a service that is not wired there
// passes everything else.

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Cause, Config, ConfigProvider, Effect, Exit, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
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
import { ProjectTrust } from "@opencode-ai/core/project/trust"
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
import type { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
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
    NodeHttpServer.layerTest,
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
      Layer.provideMerge(NodeHttpServer.layerTest),
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

const putMode = (directory: string, body: { on: boolean; sessionID?: string }) =>
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
      expect(yield* getFolder(directory)).toEqual({ on: false, externalChange: [] })
      expect(existsSync(modeFile)).toBe(false)

      const session = yield* createSession(directory)
      expect((yield* getSession(session.id, directory)).on).toBe(false)

      expect((yield* putMode(directory, { on: true })).on).toBe(true)
      expect(yield* getFolder(directory)).toEqual({ on: true, externalChange: [] })
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
