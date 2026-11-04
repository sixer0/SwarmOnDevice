import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Clock, Context, Deferred, Effect, Exit, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Autonomy } from "../../src/permission/autonomy"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"

const folder = path.join(Global.Path.state, "autonomy")
const modeFile = path.join(folder, "mode.json")
const trustFile = path.join(Global.Path.state, "trust.json")
const root = SessionID.make("ses_root_a")
const other = SessionID.make("ses_root_b")
const directory = "/abs/project"
const at = { root, directory }

// Each provide builds the layer again, which is what a new process does: memory starts over from the files.
const run = <A, E>(body: (service: Autonomy.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Autonomy.Service
      return yield* body(service)
    }).pipe(Effect.provide(Autonomy.layer)),
  )

// Another process, not this one: the write ADV-A19 is about reaches the file with the service unaware of it.
function writeFromOutside(file: string, text: string) {
  const done = Bun.spawnSync(
    [process.execPath, "-e", "require('fs').writeFileSync(process.env.TARGET, process.env.TEXT)"],
    { env: { ...process.env, TARGET: file, TEXT: text } },
  )
  expect(done.exitCode).toBe(0)
}

const markers = (id: string) => {
  const file = path.join(folder, `${id}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const clean = () => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(trustFile, { recursive: true, force: true })
}

beforeEach(clean)
afterEach(clean)

describe("mode state", () => {
  test("is off without a file, and turning it on does not touch a config", async () => {
    await run((service) =>
      Effect.gen(function* () {
        expect(yield* service.isOn(at)).toBe(false)
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.isOn(at)).toBe(true)
        expect(yield* service.isOn({ root: other, directory })).toBe(false)
      }),
    )
  })

  test("the session's answer wins over its folder's, even when it is no", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "directory", directory, on: true })
        expect(yield* service.isOn(at)).toBe(true)
        expect(yield* service.isOn({ root: other, directory })).toBe(true)
        yield* service.setMode({ scope: "session", root, on: false })
        expect(yield* service.isOn(at)).toBe(false)
        expect(yield* service.isOn({ root: other, directory })).toBe(true)
        yield* service.setMode({ scope: "directory", directory, on: false })
        expect(yield* service.isOn({ root: other, directory })).toBe(false)
      }),
    )
  })

  test("the file has the agreed shape and only its owner can read it", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        yield* service.setMode({ scope: "directory", directory, on: true })
      }),
    )
    expect(JSON.parse(readFileSync(modeFile, "utf8"))).toEqual({
      v: 1,
      sessions: { [root]: true },
      directories: { [directory]: true },
    })
    expect(statSync(modeFile).mode & 0o777).toBe(0o600)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
  })

  test("survives a restart", async () => {
    await run((service) => service.setMode({ scope: "session", root, on: true }))
    expect(await run((service) => service.isOn(at))).toBe(true)
  })

  test.each([
    ["not JSON", "{"],
    ["a list", "[]"],
    ["another version", JSON.stringify({ v: 2, sessions: { [root]: true } })],
    ["a truthy value that is not true", JSON.stringify({ v: 1, sessions: { [root]: "yes" } })],
    ["a folder set to anything but true", JSON.stringify({ v: 1, directories: { [directory]: 1 } })],
  ])("reads %s as off", async (_name, text) => {
    mkdirSync(folder, { recursive: true })
    writeFileSync(modeFile, text)
    expect(await run((service) => service.isOn(at))).toBe(false)
  })

  test("turning on fails out loud and stays off when the file cannot be written", async () => {
    mkdirSync(modeFile, { recursive: true })
    await run((service) =>
      Effect.gen(function* () {
        const exit = yield* service.setMode({ scope: "session", root, on: true }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* service.isOn(at)).toBe(false)
      }),
    )
  })

  test("turning off takes effect in memory even when the file cannot be written", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        rmSync(folder, { recursive: true, force: true })
        mkdirSync(modeFile, { recursive: true })
        const exit = yield* service.setMode({ scope: "session", root, on: false }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* service.isOn(at)).toBe(false)
      }),
    )
  })
})

// 1.1.1 R3a (S1.2-S1.4, S1.40-S1.42): the consent is memory only, per scope, and a consented run ends with one hook call.
describe("1.1.1: the consented bypass and its run", () => {
  const consent = { bypassConsent: Autonomy.BYPASS_CONSENT, reportLanguage: "id" } as const

  const hookInto = (service: Autonomy.Interface) =>
    Effect.gen(function* () {
      const calls: Autonomy.EndedRun[] = []
      const first = yield* Deferred.make<Autonomy.EndedRun>()
      yield* service.onRunEnded((ended) =>
        Effect.sync(() => calls.push(ended)).pipe(Effect.andThen(Deferred.succeed(first, ended)), Effect.asVoid),
      )
      return { calls, first: Deferred.await(first).pipe(Effect.timeout("2 seconds")) }
    })

  // The hook is forked; a second call, if there were one, would be forked the same way and land in this pause.
  const settle = Effect.promise(() => Bun.sleep(50))

  test("on with the consent sets it, on without it leaves it unset, and off clears it", async () => {
    await run((service) =>
      Effect.gen(function* () {
        expect(yield* service.bypassOf(at)).toBeUndefined()
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.bypassOf(at)).toBeUndefined()
        const before = Date.now()
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        const given = yield* service.bypassOf(at)
        expect(given?.language).toBe("id")
        expect(given?.at).toBeGreaterThanOrEqual(before)
        expect(yield* service.bypassOf({ root: other, directory })).toBeUndefined()
        yield* service.setMode({ scope: "session", root, on: false })
        expect(yield* service.bypassOf(at)).toBeUndefined()
        // On again needs the consent again.
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.bypassOf(at)).toBeUndefined()
      }),
    )
  })

  test("the report language defaults to English", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true, bypassConsent: Autonomy.BYPASS_CONSENT })
        expect((yield* service.bypassOf(at))?.language).toBe("en")
      }),
    )
  })

  test("on without the consent takes an earlier consent away", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.isOn(at)).toBe(true)
        expect(yield* service.bypassOf(at)).toBeUndefined()
      }),
    )
  })

  test("a new process starts unset although the mode file says on, and the files carry no consent", async () => {
    await run((service) => service.setMode({ scope: "session", root, on: true, ...consent }))
    expect(readFileSync(modeFile, "utf8")).not.toContain("bypass")
    await run((service) =>
      Effect.gen(function* () {
        expect(yield* service.isOn(at)).toBe(true)
        expect(yield* service.bypassOf(at)).toBeUndefined()
        // Marking the mode in the new process starts no run either.
        yield* service.markMode(at)
      }),
    )
    expect(markers(root).map((line) => line.marker)).not.toContain("bypass_on")
  })

  test("a failed switch on gives no consent", async () => {
    mkdirSync(modeFile, { recursive: true })
    await run((service) =>
      Effect.gen(function* () {
        const exit = yield* service.setMode({ scope: "session", root, on: true, ...consent }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* service.bypassOf(at)).toBeUndefined()
      }),
    )
  })

  test("directory scope: the folder's consent covers its roots, and a session's own answer wins", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "directory", directory, on: true, ...consent })
        expect(yield* service.bypassOf(at)).toBeDefined()
        expect(yield* service.bypassOf({ root: other, directory })).toBeDefined()
        expect(yield* service.bypassOf({ root, directory: "/abs/elsewhere" })).toBeUndefined()

        // On by its own answer, without consent: the folder's consent does not reach it.
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.bypassOf(at)).toBeUndefined()
        expect(yield* service.bypassOf({ root: other, directory })).toBeDefined()

        // A session's own consent stands alone once the folder goes off.
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.setMode({ scope: "directory", directory, on: false })
        expect(yield* service.bypassOf(at)).toBeDefined()
        expect(yield* service.bypassOf({ root: other, directory })).toBeUndefined()
      }),
    )
  })

  test("the bypass_on marker is written once per run, by the person, after mode_on", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.markMode(at)
        yield* service.markMode(at)
        yield* service.markMode(at)
      }),
    )
    expect(markers(root)).toMatchObject([
      { marker: "mode_on", decidedBy: "system:mode_change" },
      { marker: "bypass_on", decidedBy: "person", directory, rootID: root },
    ])
  })

  test("a root on without consent writes no bypass_on, as in 1.1.0", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        yield* service.markMode(at)
      }),
    )
    expect(markers(root).map((line) => line.marker)).toEqual(["mode_on"])
  })

  test("off ends the run: mode_off is written at once and the hook is called once with since and until", async () => {
    await run((service) =>
      Effect.gen(function* () {
        const hook = yield* hookInto(service)
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        const since = (yield* service.bypassOf(at))!.at
        yield* service.markMode(at)
        yield* service.setMode({ scope: "session", root, on: false })
        const ended = yield* hook.first
        expect(ended).toEqual({ root, directory, since, until: ended.until, language: "id" })
        expect(ended.until).toBeGreaterThanOrEqual(since)
        // Written by the switch itself, before any request marks the mode.
        expect(markers(root).map((line) => line.marker)).toEqual(["mode_on", "bypass_on", "mode_off"])
        yield* service.markMode(at)
        yield* service.setMode({ scope: "session", root, on: false })
        yield* settle
        expect(hook.calls).toHaveLength(1)
      }),
    )
    expect(markers(root).filter((line) => line.marker === "mode_off")).toHaveLength(1)
  })

  test("on without consent ends the run too, and the mode stays on", async () => {
    await run((service) =>
      Effect.gen(function* () {
        const hook = yield* hookInto(service)
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.markMode(at)
        yield* service.setMode({ scope: "session", root, on: true })
        expect((yield* hook.first).root).toBe(root)
        expect(yield* service.isOn(at)).toBe(true)
        // Still on without consent: the next mark starts nothing.
        yield* service.markMode(at)
        yield* settle
        expect(hook.calls).toHaveLength(1)
      }),
    )
    expect(markers(root).map((line) => line.marker)).toEqual(["mode_on", "bypass_on"])
  })

  test("the folder going off ends the runs of its roots", async () => {
    await run((service) =>
      Effect.gen(function* () {
        const hook = yield* hookInto(service)
        yield* service.setMode({ scope: "directory", directory, on: true, ...consent })
        yield* service.markMode(at)
        yield* service.setMode({ scope: "directory", directory, on: false })
        expect((yield* hook.first).root).toBe(root)
      }),
    )
    expect(markers(root).map((line) => line.marker)).toEqual(["mode_on", "bypass_on", "mode_off"])
  })

  test("a root marked with consent and switched on again starts a new run with its own marker", async () => {
    await run((service) =>
      Effect.gen(function* () {
        const hook = yield* hookInto(service)
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.markMode(at)
        yield* service.setMode({ scope: "session", root, on: false })
        yield* hook.first
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.markMode(at)
      }),
    )
    expect(markers(root).map((line) => line.marker)).toEqual([
      "mode_on",
      "bypass_on",
      "mode_off",
      "mode_on",
      "bypass_on",
    ])
  })

  test("with no hook the end is logged and nothing fails", async () => {
    const messages: string[] = []
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.markMode(at)
        const exit = yield* service.setMode({ scope: "session", root, on: false }).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              messages.push(JSON.stringify(options.message))
            }),
          ]),
        ),
      ),
    )
    expect(messages.some((message) => message.includes("autonomous run ended with no report hook"))).toBe(true)
  })

  test("a failing hook is logged and does not fail the switch", async () => {
    const messages: string[] = []
    await run((service) =>
      Effect.gen(function* () {
        yield* service.onRunEnded(() => Effect.die("boom"))
        yield* service.setMode({ scope: "session", root, on: true, ...consent })
        yield* service.markMode(at)
        const exit = yield* service.setMode({ scope: "session", root, on: false }).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(yield* service.isOn(at)).toBe(false)
        // The hook runs forked: wait for its log line, not for a fixed time.
        yield* Effect.promise(async () => {
          for (let i = 0; i < 200 && !messages.some((message) => message.includes("could not be reported")); i++)
            await Bun.sleep(10)
        })
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              messages.push(JSON.stringify(options.message))
            }),
          ]),
        ),
      ),
    )
    expect(messages.some((message) => message.includes("could not be reported"))).toBe(true)
  })
})

describe("ADV-A19: a program changes the state files from outside the process", () => {
  let project: string

  beforeAll(() => {
    ProjectTrust.assumeTrustedForTests(false)
    project = mkdtempSync(path.join(os.tmpdir(), "autonomy-state-"))
    // Something in the folder worth asking about, so an untrusted folder reads "ask" and not "clean".
    writeFileSync(path.join(project, "swarm.json"), JSON.stringify({ mcp: { x: { command: ["x"] } } }))
  })
  afterAll(() => {
    ProjectTrust.assumeTrustedForTests(true)
    rmSync(project, { recursive: true, force: true })
  })

  const trustedOutside = () => JSON.stringify({ directories: { [ProjectTrust.rootOf(project)]: { at: 1 } } })

  test("trust.json: memory keeps its answer, the marker is written, and P becomes D", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.folderState(project)).toBe("ask")
        const before = yield* service.check(at)
        expect(before.externalChange).toEqual([])
        expect(Autonomy.afterCheck("P", before)).toBe("P")

        writeFromOutside(trustFile, trustedOutside())
        // The file now says trusted, which is exactly what must not take effect.
        expect(ProjectTrust.isTrusted(project)).toBe(true)
        expect(yield* service.folderState(project)).toBe("ask")

        const after = yield* service.check(at)
        expect(after.on).toBe(true)
        expect(after.externalChange).toEqual(["trust.json"])
        expect(Autonomy.afterCheck("P", after)).toBe("D")
        expect(yield* service.externalChange()).toEqual(["trust.json"])
      }),
    )
    expect(markers(root)).toMatchObject([
      {
        v: 1,
        type: "marker",
        rootID: root,
        directory,
        marker: "external_change",
        files: ["trust.json"],
        decidedBy: "system:external_change",
      },
    ])
  })

  test("mode.json: a session switched on from outside stays off, and the marker reaches a session that is on", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root: other, on: true })
        writeFromOutside(modeFile, JSON.stringify({ v: 1, sessions: { [root]: true, [other]: true }, directories: {} }))
        expect(yield* service.isOn(at)).toBe(false)
        const seen = yield* service.check({ root: other, directory })
        expect(seen.externalChange).toEqual(["mode.json"])
        expect(yield* service.isOn(at)).toBe(false)
      }),
    )
    expect(markers(other)).toMatchObject([{ marker: "external_change", files: ["mode.json"] }])
    expect(markers(root)).toEqual([])
  })

  test.each([
    ["deleted", () => rmSync(trustFile)],
    [
      "replaced by something that is not a file",
      () => {
        rmSync(trustFile)
        mkdirSync(trustFile)
      },
    ],
  ])("trust.json %s counts as a change, and memory still says trusted", async (_name, change) => {
    writeFileSync(trustFile, trustedOutside())
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.folderState(project)).toBe("trusted")
        change()
        const seen = yield* service.check(at)
        expect(seen.externalChange).toEqual(["trust.json"])
        expect(Autonomy.afterCheck("P", seen)).toBe("D")
        expect(yield* service.folderState(project)).toBe("trusted")
      }),
    )
  })

  test("putting the bytes back does not clear the warning", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        writeFromOutside(trustFile, trustedOutside())
        yield* service.check(at)
        rmSync(trustFile)
        const seen = yield* service.check(at)
        expect(seen.externalChange).toEqual(["trust.json"])
      }),
    )
  })

  test("a change the gate has not looked at yet is not hidden by the next write of the mode", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        writeFromOutside(modeFile, JSON.stringify({ v: 1, sessions: { [root]: true, [other]: true } }))
        yield* service.setMode({ scope: "session", root: other, on: false })
        const seen = yield* service.check(at)
        expect(seen.externalChange).toEqual(["mode.json"])
        expect(Autonomy.afterCheck("P", seen)).toBe("D")
      }),
    )
  })

  test("the marker is written once per root and file, and only for a root that is on", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        yield* service.setMode({ scope: "directory", directory: "/abs/second", on: true })
        writeFromOutside(trustFile, trustedOutside())
        yield* service.check(at)
        yield* service.check(at)
        const off = yield* service.check({ root: SessionID.make("ses_off"), directory })
        expect(off.on).toBe(false)
        yield* service.check({ root: other, directory: "/abs/second" })
      }),
    )
    expect(markers(root)).toHaveLength(1)
    expect(markers(other)).toHaveLength(1)
    expect(markers("ses_off")).toEqual([])
  })

  test("a marker that could not be written is tried again, and the class is held meanwhile", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        writeFromOutside(trustFile, trustedOutside())
        const audit = path.join(folder, `${root}.jsonl`)
        mkdirSync(audit)
        const seen = yield* service.check(at)
        expect(Autonomy.afterCheck("P", seen)).toBe("D")
        rmSync(audit, { recursive: true })
        yield* service.check(at)
      }),
    )
    expect(markers(root)).toHaveLength(1)
  })

  test("a session ID cannot steer the marker out of the folder", async () => {
    const escape = "ses/../../escaped" as SessionID
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root: escape, on: true })
        writeFromOutside(trustFile, trustedOutside())
        yield* service.check({ root: escape, directory })
      }),
    )
    expect(existsSync(path.join(Global.Path.state, "escaped.jsonl"))).toBe(false)
    expect(markers("escaped")).toHaveLength(1)
    rmSync(path.join(folder, "escaped.jsonl"), { force: true })
  })

  test("confirming takes in what the file says and P stays P from then on", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        writeFromOutside(trustFile, trustedOutside())
        expect(Autonomy.afterCheck("P", yield* service.check(at))).toBe("D")
        yield* service.confirm()
        expect(yield* service.externalChange()).toEqual([])
        expect(yield* service.folderState(project)).toBe("trusted")
        const seen = yield* service.check(at)
        expect(seen.externalChange).toEqual([])
        expect(Autonomy.afterCheck("P", seen)).toBe("P")

        // A later change is a new one: it warns again and writes its own marker.
        writeFromOutside(trustFile, JSON.stringify({ directories: {} }))
        expect((yield* service.check(at)).externalChange).toEqual(["trust.json"])
      }),
    )
    expect(markers(root)).toHaveLength(2)
  })

  test("trust given through the app does not read as a change from outside", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        expect(yield* service.grantTrust(project)).toBe(ProjectTrust.rootOf(project))
        expect(yield* service.folderState(project)).toBe("trusted")
        expect((yield* service.check(at)).externalChange).toEqual([])
      }),
    )
  })

  test("trust given through the app takes nothing else from a file changed from outside", async () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "autonomy-state-"))
    writeFileSync(path.join(elsewhere, "swarm.json"), JSON.stringify({ mcp: { x: { command: ["x"] } } }))
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        writeFromOutside(trustFile, JSON.stringify({ directories: { [ProjectTrust.rootOf(elsewhere)]: { at: 1 } } }))
        yield* service.grantTrust(project)
        expect(yield* service.folderState(project)).toBe("trusted")
        expect(yield* service.folderState(elsewhere)).toBe("ask")
        expect((yield* service.check(at)).externalChange).toEqual(["trust.json"])
      }),
    )
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

describe("the class after a check", () => {
  const changed = { on: true, externalChange: ["trust.json" as const] }
  const quiet = { on: true, externalChange: [] }

  test.each(["A", "D", "B", "X"] as const)("%s is left alone", (value) => {
    expect(Autonomy.afterCheck(value, changed)).toBe(value)
  })

  test("only P is held back, and only while a change is open", () => {
    expect(Autonomy.afterCheck("P", changed)).toBe("D")
    expect(Autonomy.afterCheck("P", quiet)).toBe("P")
  })
})

// Row 130: the consent list per root, made once the mission is known, with real sessions and messages.
const live = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, EventV2Bridge.node, Session.node, SessionProjector.node, Autonomy.node]),
  ),
)

const say = Effect.fn("AutonomyStateTest.say")(function* (sessionID: SessionID, text: string) {
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

// A root in a folder with one secret file, as the switch in the `+` menu leaves it: setMode, then the route's mark.
const rootWithSecret = Effect.fn("AutonomyStateTest.rootWithSecret")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({})
  const directory = (yield* sessions.get(root.id)).directory
  writeFileSync(path.join(directory, ".env"), "TOKEN=not-read\n")
  return { root: root.id, directory }
})

const switchMode = Effect.fn("AutonomyStateTest.switchMode")(function* (where: Autonomy.Where, on: boolean) {
  const autonomy = yield* Autonomy.Service
  yield* autonomy.setMode({ scope: "session", root: where.root, on })
  yield* autonomy.markMode(where)
})

const linesOf = Effect.fn("AutonomyStateTest.linesOf")(function* (root: SessionID) {
  const autonomy = yield* Autonomy.Service
  return (yield* autonomy.readAudit(root)).lines
})

const markerNames = (lines: readonly Autonomy.AuditLine[]) =>
  lines.flatMap((line) => (line.type === "marker" ? [line.marker] : []))

describe("row 130: consent state and when the scan runs", () => {
  live.instance("mode on with a person message: the list is there before the first call, and names it", () =>
    Effect.gen(function* () {
      const autonomy = yield* Autonomy.Service
      const where = yield* rootWithSecret()
      yield* say(where.root, "Perbaiki konfigurasi di .env lalu jalankan uji.")
      yield* switchMode(where, true)

      // No wait between the switch and the first call: the list is already made.
      const consent = yield* autonomy.consent(where.root)
      expect(consent?.items.map((item) => [item.pattern, item.named, item.checked, item.files])).toEqual([
        [".env*", true, true, [path.join(where.directory, ".env")]],
      ])
      expect(consent?.given.size).toBe(0)
      // The first request's gate marks the mode again, and nothing is written twice.
      yield* autonomy.markMode(where)
      const lines = yield* linesOf(where.root)
      expect(markerNames(lines)).toEqual(["mode_on", "credential_snapshot", "consent_shown"])
      const shown = lines.find((line) => line.type === "marker" && line.marker === "consent_shown")
      expect(shown?.type === "marker" && [shown.hash, shown.consentID]).toEqual([consent!.hash, consent!.id])
      // Names only: the scan left the file's text out of the record.
      expect(JSON.stringify(lines)).not.toContain("not-read")
    }),
  )

  live.instance("mode on without a person message: nothing yet, and the list comes with the first one", () =>
    Effect.gen(function* () {
      const autonomy = yield* Autonomy.Service
      const where = yield* rootWithSecret()
      yield* switchMode(where, true)
      expect(yield* autonomy.consent(where.root)).toBeUndefined()
      expect(markerNames(yield* linesOf(where.root))).toEqual(["mode_on"])

      yield* say(where.root, "Rapikan README.")
      // The gate's mark on the first request after that message.
      yield* autonomy.markMode(where)
      const consent = yield* autonomy.consent(where.root)
      // Not named in the message: listed, and left for the person to tick.
      expect(consent?.items.map((item) => [item.pattern, item.named, item.checked])).toEqual([[".env*", false, false]])
      expect(markerNames(yield* linesOf(where.root))).toEqual(["mode_on", "credential_snapshot", "consent_shown"])
    }),
  )

  live.instance("mode off takes the list and what was allowed with it, and on again starts a new one", () =>
    Effect.gen(function* () {
      const autonomy = yield* Autonomy.Service
      const where = yield* rootWithSecret()
      yield* say(where.root, "Perbaiki .env")
      yield* switchMode(where, true)
      const first = (yield* autonomy.consent(where.root))!
      yield* autonomy.allowConsent({ root: where.root, hash: first.hash, ids: [first.items[0]!.id] })

      yield* autonomy.setMode({ scope: "session", root: where.root, on: false })
      // Gone with the switch itself, before any mark.
      expect(yield* autonomy.consent(where.root)).toBeUndefined()
      yield* autonomy.markMode(where)
      expect(markerNames(yield* linesOf(where.root)).slice(-2)).toEqual(["mode_off", "consent_cleared"])
      const stale = yield* autonomy
        .allowConsent({ root: where.root, hash: first.hash, ids: [first.items[0]!.id] })
        .pipe(Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)

      yield* switchMode(where, true)
      const again = yield* autonomy.consent(where.root)
      expect(again?.items).toHaveLength(1)
      expect(again?.given.size).toBe(0)
      expect(Autonomy.consentedFile(again, path.join(where.directory, ".env"))).toBeUndefined()
    }),
  )

  live.instance("only the shown list can be answered, and each allowed item gets a line of its own by the person", () =>
    Effect.gen(function* () {
      const autonomy = yield* Autonomy.Service
      const where = yield* rootWithSecret()
      yield* say(where.root, "Kerjakan tugas ini.")
      yield* switchMode(where, true)
      const consent = (yield* autonomy.consent(where.root))!
      const file = path.join(where.directory, ".env")

      const wrong = yield* autonomy
        .allowConsent({ root: where.root, hash: "0".repeat(64), ids: [consent.items[0]!.id] })
        .pipe(Effect.exit)
      expect(Exit.isFailure(wrong)).toBe(true)
      expect(Autonomy.consentedFile(yield* autonomy.consent(where.root), file)).toBeUndefined()

      // An id that is not on the list allows nothing.
      yield* autonomy.allowConsent({ root: where.root, hash: consent.hash, ids: ["secret:*.pem"] })
      expect((yield* autonomy.consent(where.root))?.given.size).toBe(0)

      const after = yield* autonomy.allowConsent({ root: where.root, hash: consent.hash, ids: [consent.items[0]!.id] })
      expect(Autonomy.consentedFile(after, file)?.pattern).toBe(".env*")
      // Only the concrete path that was scanned: a file added later is not covered by the pattern.
      expect(Autonomy.consentedFile(after, path.join(where.directory, ".env.local"))).toBeUndefined()
      const lines = yield* linesOf(where.root)
      expect(
        lines.flatMap((line) =>
          line.type === "decision"
            ? [[line.permission, line.class, line.category, line.decidedBy, line.consentID]]
            : [],
        ),
      ).toEqual([["autonomy_consent", "A", "consented", "person", consent.items[0]!.id]])
      expect(markerNames(lines).at(-1)).toBe("consent_given")
    }),
  )

  live.instance("a restart keeps when the mode came on, does not mark it again, and forgets what was allowed", () =>
    Effect.gen(function* () {
      const autonomy = yield* Autonomy.Service
      const where = yield* rootWithSecret()
      yield* say(where.root, "Perbaiki .env")
      // The line's time and the mode's time are two reads of the clock; a real one can tick between them (1 ms).
      const clock = yield* TestClock.make()
      yield* clock.adjust(1_000_000)
      yield* switchMode(where, true).pipe(Effect.provideService(Clock.Clock, clock))
      const since = yield* autonomy.modeSince(where.root)
      expect(since).toBeNumber()
      const consent = (yield* autonomy.consent(where.root))!
      yield* autonomy.allowConsent({ root: where.root, hash: consent.hash, ids: [consent.items[0]!.id] })

      // A new process: the layer built again over the same files and database.
      const context = yield* Layer.build(Layer.fresh(Autonomy.layer))
      const restarted = Context.get(context, Autonomy.Service)
      yield* restarted.markMode(where).pipe(Effect.provideService(Clock.Clock, clock))
      expect(yield* restarted.modeSince(where.root)).toBe(since)
      const lines = (yield* restarted.readAudit(where.root)).lines
      expect(markerNames(lines).filter((name) => name === "mode_on")).toHaveLength(1)
      const fresh = yield* restarted.consent(where.root)
      expect(fresh?.given.size).toBe(0)
      expect(Autonomy.consentedFile(fresh, path.join(where.directory, ".env"))).toBeUndefined()
    }),
  )
})
