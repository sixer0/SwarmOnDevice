// 1.2.6 row 38a (P-01c, SEC-06, SEC-07; 01b §6 and §9.4): the person's route that puts a checkpoint back.
// `POST /session/:sessionID/autonomy/checkpoint/:checkpointID/revert` needs the server password AND the per-launch
// desktop nonce (`x-swarm-desktop-nonce`, N-147); it saves the current bytes first (so a revert can be undone), checks the
// manifest against the `manifestSha256` of the audit line written when the checkpoint was made, refuses ref names git
// could read as options, and writes its own audit line. The archive-empty route takes the same nonce (RV-8).
//
// Run targeted: cd packages/opencode && bun test test/server/autonomy-checkpoint-route.test.ts

import { NodeServices } from "@effect/platform-node"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { rmSync } from "node:fs"
import path from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Workspace } from "../../src/control-plane/workspace"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { ServerAuth } from "../../src/server/auth"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { AutonomyApi } from "../../src/server/routes/instance/httpapi/groups/autonomy"
import { autonomyHandlers } from "../../src/server/routes/instance/httpapi/handlers/autonomy"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import type { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { Archive } from "../../src/tool/archive"
import { ActionCheckpoint } from "../../src/tool/checkpoint"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { loopbackServer } from "../permission/loopback-server"

const auditFolder = path.join(Global.Path.state, "autonomy")
const clean = () => rmSync(auditFolder, { recursive: true, force: true })

const PASSWORD = "revert-route-test-only"
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
// What the desktop sends: 32 random bytes as base64url. Fixed here so a failure names it.
const NONCE = "rv8-nonce-0123456789abcdefghijklmnopqrstu"
const OTHER = "rv8-other-0123456789abcdefghijklmnopqrstu"

beforeEach(() => {
  clean()
  DesktopNonce.set(NONCE)
})
afterEach(() => {
  clean()
  DesktopNonce.set(undefined)
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: () => Effect.succeed({ decision: "allow" as const, decidedBy: "agent:test/stub" }),
  }),
)

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

type Sent = { authorized?: boolean; nonce?: string; body?: unknown }

const post = (url: string, directory: string, options: Sent = {}) =>
  Effect.gen(function* () {
    let request = HttpClientRequest.post(url).pipe(HttpClientRequest.setHeader("x-opencode-directory", directory))
    if (options.authorized !== false) request = request.pipe(HttpClientRequest.setHeader("authorization", AUTHORIZATION))
    if (options.nonce !== undefined) request = request.pipe(HttpClientRequest.setHeader(DesktopNonce.HEADER, options.nonce))
    // The revert route takes no body; only the archive-empty route is sent one.
    const sent = options.body === undefined ? request : yield* HttpClientRequest.bodyJson(request, options.body)
    const response = yield* HttpClient.execute(sent)
    return { status: response.status, body: (yield* response.json) as Record<string, any> }
  })

const revertAt = (sessionID: string, id: string) => `/session/${sessionID}/autonomy/checkpoint/${id}/revert`
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const checkpoints = (directory: string) =>
  existsSync(path.join(directory, ActionCheckpoint.CHECKPOINT_DIR))
    ? readdirSync(path.join(directory, ActionCheckpoint.CHECKPOINT_DIR)).filter((name) => /^\d{8}-/.test(name)).sort()
    : []
const auditOf = (root: string) => {
  const file = path.join(auditFolder, `${root}.jsonl`)
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
}
const git = (cwd: string, ...args: string[]) => {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`)
  return out.stdout.trim()
}

// A root session (and a subagent under it), as a run in autonomous mode has them.
const family = Effect.fn("RevertRouteTest.family")(function* () {
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  const root = yield* sessions.create({})
  const child = yield* sessions.create({ parentID: root.id })
  return { directory: test.directory, root, child }
})

// What the shell does before an I-F/I-G call (row 37b): the checkpoint, and its `checkpointed` line on the root's record.
const saved = Effect.fn("RevertRouteTest.saved")(function* (
  root: SessionID,
  directory: string,
  input: { targets: string[]; refs?: string[]; now?: Date; unrecorded?: boolean },
) {
  const autonomy = yield* Autonomy.Service
  const made = yield* Effect.promise(() =>
    ActionCheckpoint.create({
      directory,
      targets: input.targets,
      refs: input.refs,
      sessionID: root,
      requestID: "per_test",
      command: "test",
      now: input.now ?? new Date(2026, 10, 12, 9, 0, 0),
      record: input.unrecorded ? undefined : Autonomy.checkpointRecorder(autonomy.record, { root, directory }),
    }),
  )
  if (!made.ok) throw new Error(`checkpoint failed: ${made.reason}`)
  expect(made.recorded).toBe(true)
  return made
})

// Someone who can write the record as well as the checkpoint: the line names the sha of the manifest as it is now. Only
// the first line for an id counts, so the deeper checks are reached only when this is that first line.
const recordSha = Effect.fn("RevertRouteTest.recordSha")(function* (root: SessionID, directory: string, id: string) {
  const autonomy = yield* Autonomy.Service
  const raw = readFileSync(path.join(directory, ActionCheckpoint.CHECKPOINT_DIR, id, "manifest.json"))
  yield* autonomy.record(root, {
    type: "outcome",
    requestID: "per_forged",
    outcome: "checkpointed",
    checkpoint: id,
    entries: 1,
    bytes: 0,
    refs: 1,
    manifestSha256: sha(raw),
  })
})

it.instance("RV-1, RV-7: a revert with password and nonce restores the bytes after a pre-revert checkpoint, and can be undone", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root, child } = yield* family()
    const notes = path.join(directory, "notes.txt")
    writeFileSync(notes, "old\n")
    const made = yield* saved(root.id, directory, { targets: ["notes.txt"] })
    writeFileSync(notes, "new\n")

    // Asked from a subagent's session: the root's folder and record answer.
    const reverted = yield* post(revertAt(child.id, made.id), directory, { nonce: NONCE })
    expect(reverted.status).toBe(200)
    expect(reverted.body).toMatchObject({ id: made.id, restored: ["notes.txt"], verified: true })
    expect(readFileSync(notes, "utf8")).toBe("old\n")
    expect(sha(readFileSync(notes))).toBe(made.manifest.entries[0]!.sha256!)

    // The bytes as they were just before are a checkpoint of their own, recorded like any other.
    const pre = reverted.body.preRevert as string
    expect(pre).not.toBe(made.id)
    expect(checkpoints(directory)).toEqual([made.id, pre].sort())
    expect(readFileSync(path.join(directory, ActionCheckpoint.CHECKPOINT_DIR, pre, "notes.txt"), "utf8")).toBe("new\n")
    const lines = auditOf(root.id)
    expect(lines.filter((line) => line.outcome === "checkpointed").map((line) => line.checkpoint)).toEqual([made.id, pre])
    // SEC-06: the revert itself is on the record, with the checkpoint, who asked and how it ended.
    const done = lines.filter((line) => line.outcome === "undone")
    expect(done.map((line) => [line.checkpoint, line.by])).toEqual([[made.id, "person"]])

    // RV-7: the revert of the pre-revert checkpoint brings "new\n" back.
    const undone = yield* post(revertAt(root.id, pre), directory, { nonce: NONCE })
    expect(undone.status).toBe(200)
    expect(readFileSync(notes, "utf8")).toBe("new\n")
  }),
)

it.instance(
  "RV-2: a Git checkpoint puts the branch back on its commit and the uncommitted file back byte for byte",
  () =>
    Effect.gen(function* () {
      yield* serveGroupWith(PASSWORD)
      const { directory, root } = yield* family()
      const file = path.join(directory, "a.txt")
      writeFileSync(file, "one\n")
      git(directory, "add", "a.txt")
      git(directory, "commit", "-qm", "one")
      writeFileSync(file, "two\n")
      git(directory, "commit", "-qam", "two")
      const recorded = git(directory, "rev-parse", "HEAD")
      const branch = git(directory, "symbolic-ref", "HEAD")
      writeFileSync(file, "dirty, not committed\n")
      const made = yield* saved(root.id, directory, { targets: ["a.txt"], refs: [branch] })

      git(directory, "reset", "-q", "--hard", "HEAD~1")
      expect(git(directory, "rev-parse", "HEAD")).not.toBe(recorded)

      const reverted = yield* post(revertAt(root.id, made.id), directory, { nonce: NONCE })
      expect(reverted.status).toBe(200)
      expect(git(directory, "rev-parse", "HEAD")).toBe(recorded)
      expect(readFileSync(file, "utf8")).toBe("dirty, not committed\n")
    }),
  { git: true },
)

it.instance("RV-3: an unknown checkpoint is 404 NotFoundError, and nothing changes or is saved", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root } = yield* family()
    const notes = path.join(directory, "notes.txt")
    writeFileSync(notes, "old\n")
    const made = yield* saved(root.id, directory, { targets: ["notes.txt"] })
    writeFileSync(notes, "new\n")

    for (const id of ["20990101-000000-1", "not-an-id", "..%2F..%2Fetc"]) {
      const missing = yield* post(revertAt(root.id, id), directory, { nonce: NONCE })
      expect(missing.status).toBe(404)
      expect(missing.body.name).toBe("NotFoundError")
    }
    // A checkpoint the root never recorded is not this session's to revert.
    const other = yield* Session.Service.use((sessions) => sessions.create({}))
    const foreign = yield* post(revertAt(other.id, made.id), directory, { nonce: NONCE })
    expect(foreign.status).toBe(404)

    expect(readFileSync(notes, "utf8")).toBe("new\n")
    expect(checkpoints(directory)).toEqual([made.id])
    expect(auditOf(root.id).filter((line) => line.outcome === "undone")).toEqual([])
  }),
)

it.instance("RV-4: a server with no password reverts nothing", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(undefined)
    const { directory, root } = yield* family()
    const notes = path.join(directory, "notes.txt")
    writeFileSync(notes, "old\n")
    const made = yield* saved(root.id, directory, { targets: ["notes.txt"] })
    writeFileSync(notes, "new\n")

    const refused = yield* post(revertAt(root.id, made.id), directory, { authorized: false, nonce: NONCE })
    expect(refused.status).toBe(403)
    expect(refused.body.name).toBe("AutonomyNoPasswordError")
    expect(readFileSync(notes, "utf8")).toBe("new\n")
    expect(checkpoints(directory)).toEqual([made.id])
  }),
)

it.instance("RV-4: a request without the password is turned away before the route", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root } = yield* family()
    writeFileSync(path.join(directory, "notes.txt"), "old\n")
    const made = yield* saved(root.id, directory, { targets: ["notes.txt"] })
    writeFileSync(path.join(directory, "notes.txt"), "new\n")
    const refused = yield* post(revertAt(root.id, made.id), directory, { authorized: false, nonce: NONCE })
    expect(refused.status).toBe(401)
    expect(readFileSync(path.join(directory, "notes.txt"), "utf8")).toBe("new\n")
  }),
)

it.instance("RV-5: a checkpoint that is a link, or whose manifest names a path outside the folder, restores nothing", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root } = yield* family()
    const notes = path.join(directory, "notes.txt")
    writeFileSync(notes, "old\n")
    const first = yield* saved(root.id, directory, { targets: ["notes.txt"] })
    const second = yield* saved(root.id, directory, {
      targets: ["notes.txt"],
      now: new Date(2026, 10, 12, 9, 0, 1),
      unrecorded: true,
    })
    writeFileSync(notes, "new\n")

    // The first checkpoint's folder swapped for a link to a copy of itself.
    const area = path.join(directory, ActionCheckpoint.CHECKPOINT_DIR)
    renameSync(path.join(area, first.id), path.join(directory, "moved-away"))
    symlinkSync(path.join(directory, "moved-away"), path.join(area, first.id))
    const linked = yield* post(revertAt(root.id, first.id), directory, { nonce: NONCE })
    expect(linked.status).toBe(404)
    expect(readFileSync(notes, "utf8")).toBe("new\n")

    // The second one's manifest names a file outside the folder, and its (first) record line was made to match it.
    const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside.txt`)
    writeFileSync(outside, "keep\n")
    const file = path.join(area, second.id, "manifest.json")
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    manifest.entries[0].path = "../" + path.basename(outside)
    manifest.targets = ["../" + path.basename(outside)]
    writeFileSync(file, JSON.stringify(manifest))
    yield* recordSha(root.id, directory, second.id)
    const escaped = yield* post(revertAt(root.id, second.id), directory, { nonce: NONCE })
    expect(escaped.status).toBe(500)
    expect(escaped.body.name).toBe("AutonomyWriteError")
    expect(readFileSync(outside, "utf8")).toBe("keep\n")
    expect(readFileSync(notes, "utf8")).toBe("new\n")
    rmSync(outside, { force: true })
    // Nothing saved for a revert that never started.
    expect(checkpoints(directory)).toEqual([first.id, second.id].sort())
  }),
)

it.instance("RV-6: a file the action created is moved to the archive, never deleted", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root } = yield* family()
    const made = yield* saved(root.id, directory, { targets: ["made.txt"] })
    expect(made.manifest.entries[0]!.existed).toBe(false)
    writeFileSync(path.join(directory, "made.txt"), "created later\n")

    const reverted = yield* post(revertAt(root.id, made.id), directory, { nonce: NONCE })
    expect(reverted.status).toBe(200)
    expect(existsSync(path.join(directory, "made.txt"))).toBe(false)
    const archive = path.join(directory, Archive.ARCHIVE_DIR)
    const kept = readdirSync(archive).filter((name) => /^\d{8}-/.test(name))
    expect(kept.length).toBe(1)
    expect(readFileSync(path.join(archive, kept[0]!, "made.txt"), "utf8")).toBe("created later\n")
  }),
)

it.instance("RV-8: with the password but without the desktop nonce, nothing is reverted or emptied", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root } = yield* family()
    const notes = path.join(directory, "notes.txt")
    writeFileSync(notes, "old\n")
    const made = yield* saved(root.id, directory, { targets: ["notes.txt"] })
    writeFileSync(notes, "new\n")

    for (const nonce of [undefined, "", OTHER, NONCE.slice(0, -1), `${NONCE}x`]) {
      const refused = yield* post(revertAt(root.id, made.id), directory, { nonce })
      expect(refused.status).toBe(403)
      expect(refused.body.name).toBe("AutonomyNoPasswordError")
    }
    // A server that was never given a nonce (not started by the desktop app) takes none.
    DesktopNonce.set(undefined)
    const unset = yield* post(revertAt(root.id, made.id), directory, { nonce: NONCE })
    expect(unset.status).toBe(403)
    expect(readFileSync(notes, "utf8")).toBe("new\n")
    expect(checkpoints(directory)).toEqual([made.id])
    expect(auditOf(root.id).filter((line) => line.outcome === "undone")).toEqual([])

    // The archive-empty route takes the same nonce.
    DesktopNonce.set(NONCE)
    mkdirSync(path.join(directory, "build"))
    writeFileSync(path.join(directory, "build", "a.js"), "1")
    const moved = yield* Effect.promise(() => Archive.move({ directory, paths: ["build"] }))
    if (!moved.ok) throw new Error("archive move failed")
    const emptyAt = `/session/${root.id}/autonomy/archive/empty`
    const kept = yield* post(emptyAt, directory, { body: { ids: [moved.id] } })
    expect(kept.status).toBe(403)
    expect(kept.body.name).toBe("AutonomyNoPasswordError")
    expect(existsSync(path.join(directory, Archive.ARCHIVE_DIR, moved.id))).toBe(true)
    const emptied = yield* post(emptyAt, directory, { body: { ids: [moved.id] }, nonce: NONCE })
    expect(emptied.status).toBe(200)
    expect(existsSync(path.join(directory, Archive.ARCHIVE_DIR, moved.id))).toBe(false)

    // With both, the revert goes through and is recorded.
    const reverted = yield* post(revertAt(root.id, made.id), directory, { nonce: NONCE })
    expect(reverted.status).toBe(200)
    expect(auditOf(root.id).filter((line) => line.outcome === "undone").length).toBe(1)
  }),
)

it.instance("RV-9: a manifest edited after it was made is refused, and the bytes stay as they are", () =>
  Effect.gen(function* () {
    yield* serveGroupWith(PASSWORD)
    const { directory, root } = yield* family()
    const notes = path.join(directory, "notes.txt")
    writeFileSync(notes, "old\n")
    const made = yield* saved(root.id, directory, { targets: ["notes.txt"] })
    writeFileSync(notes, "new\n")
    const file = path.join(directory, ActionCheckpoint.CHECKPOINT_DIR, made.id, "manifest.json")
    // Still a valid manifest naming the same file: only its bytes differ from what was recorded.
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    manifest.command = "something else"
    writeFileSync(file, JSON.stringify(manifest, null, 2))

    const refused = yield* post(revertAt(root.id, made.id), directory, { nonce: NONCE })
    expect(refused.status).toBe(500)
    expect(refused.body.name).toBe("AutonomyWriteError")
    expect(readFileSync(notes, "utf8")).toBe("new\n")
    expect(checkpoints(directory)).toEqual([made.id])

    // A line appended later naming the changed manifest's sha does not vouch for it: the line written at creation counts.
    yield* recordSha(root.id, directory, made.id)
    const still = yield* post(revertAt(root.id, made.id), directory, { nonce: NONCE })
    expect(still.status).toBe(500)
    expect(readFileSync(notes, "utf8")).toBe("new\n")
    expect(checkpoints(directory)).toEqual([made.id])
    const failed = auditOf(root.id).filter((line) => line.outcome === "failed")
    expect(failed.map((line) => [line.checkpoint, line.by])).toEqual([
      [made.id, "person"],
      [made.id, "person"],
    ])
  }),
)

it.instance(
  "RV-10: a ref name git could read as an option or a path is refused before git sees it",
  () =>
    Effect.gen(function* () {
      yield* serveGroupWith(PASSWORD)
      const { directory, root } = yield* family()
      const file = path.join(directory, "a.txt")
      writeFileSync(file, "one\n")
      git(directory, "add", "a.txt")
      git(directory, "commit", "-qm", "one")
      const head = git(directory, "rev-parse", "HEAD")
      const branch = git(directory, "symbolic-ref", "HEAD")
      const names = ["--stdin", "../x", "refs/heads/../../x", "-d"]
      const made: string[] = []
      for (const [index, name] of names.entries()) {
        const one = yield* saved(root.id, directory, {
          targets: ["a.txt"],
          refs: [branch],
          now: new Date(2026, 10, 12, 9, 0, index),
          unrecorded: true,
        })
        made.push(one.id)
        const manifestFile = path.join(directory, ActionCheckpoint.CHECKPOINT_DIR, one.id, "manifest.json")
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
        manifest.refs[0].name = name
        writeFileSync(manifestFile, JSON.stringify(manifest))
        yield* recordSha(root.id, directory, one.id)
      }
      writeFileSync(file, "changed\n")

      for (const id of made) {
        const refused = yield* post(revertAt(root.id, id), directory, { nonce: NONCE })
        expect(refused.status).toBe(500)
        expect(refused.body.name).toBe("AutonomyWriteError")
        expect(readFileSync(file, "utf8")).toBe("changed\n")
        expect(git(directory, "rev-parse", "HEAD")).toBe(head)
      }
      expect(existsSync(path.join(directory, "x"))).toBe(false)
      expect(checkpoints(directory)).toEqual(made.toSorted())
      expect(lstatSync(path.join(directory, ActionCheckpoint.CHECKPOINT_DIR)).mode & 0o777).toBe(0o700)
    }),
  { git: true },
)

test("SEC-06: the nonce holder takes only a nonce, compares exactly, and forgets on request", () => {
  DesktopNonce.set(undefined)
  expect(DesktopNonce.present()).toBe(false)
  expect(DesktopNonce.matches(NONCE)).toBe(false)
  expect(() => DesktopNonce.set("short")).toThrow()
  expect(() => DesktopNonce.set(`${NONCE}\n`)).toThrow()
  expect(DesktopNonce.present()).toBe(false)
  DesktopNonce.set(NONCE)
  expect(DesktopNonce.present()).toBe(true)
  expect(DesktopNonce.matches(NONCE)).toBe(true)
  expect(DesktopNonce.matches(OTHER)).toBe(false)
  expect(DesktopNonce.matches(undefined)).toBe(false)
  expect(DesktopNonce.matches("")).toBe(false)
  expect(DesktopNonce.HEADER).toBe("x-swarm-desktop-nonce")
})

test("SEC-06: the generated client has the revert route and sends the nonce header", () => {
  const sdk = readFileSync(new URL("../../../sdk/js/src/v2/gen/sdk.gen.ts", import.meta.url), "utf8")
  expect(sdk).toContain('url: "/session/{sessionID}/autonomy/checkpoint/{checkpointID}/revert"')
  const at = sdk.indexOf("public checkpointRevert")
  expect(at).toBeGreaterThan(0)
  expect(sdk.slice(at, at + 1500)).toContain('in: "headers", key: "x-swarm-desktop-nonce"')
})
