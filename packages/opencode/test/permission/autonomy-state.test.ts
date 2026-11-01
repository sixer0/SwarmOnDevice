import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { Autonomy } from "../../src/permission/autonomy"
import { SessionID } from "../../src/session/schema"

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
