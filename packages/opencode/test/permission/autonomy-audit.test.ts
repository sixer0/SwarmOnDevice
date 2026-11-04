import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Autonomy } from "../../src/permission/autonomy"
import { Archive } from "../../src/tool/archive"
import { SessionID } from "../../src/session/schema"

const folder = path.join(Global.Path.state, "autonomy")
const root = SessionID.make("ses_audit_a")
const directory = "/abs/project"
const file = (id = root as string) => path.join(folder, `${id}.jsonl`)
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

// Each provide builds the layer again, which is what a new process does: the head in memory starts over.
const run = <A, E>(body: (service: Autonomy.Interface) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Autonomy.Service
      return yield* body(service)
    }).pipe(Effect.provide(Autonomy.layer)),
  )

const raw = (id = root as string) => readFileSync(file(id), "utf8").split("\n").filter(Boolean)
const lines = (id = root as string) => raw(id).map((line) => JSON.parse(line))

const decision = (over: Partial<Extract<Autonomy.AuditEntry, { type: "decision" }>> = {}) =>
  ({
    type: "decision",
    sessionID: "ses_child",
    requestID: "per_1",
    messageID: "msg_1",
    callID: "call_1",
    agent: "general",
    rootAgent: "build",
    directory,
    permission: "bash",
    patterns: ["bun test test/a.test.ts"],
    class: "P",
    category: "check",
    canUndo: true,
    decidedBy: "agent:gsp-ai-tail/thinker",
    decision: "allow",
    reason: "a local test run",
    latencyMs: 2100,
    costUsd: 0,
    ...over,
  }) satisfies Autonomy.AuditEntry

beforeEach(() => rmSync(folder, { recursive: true, force: true }))
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe("schema", () => {
  const decode = Schema.decodeUnknownExit(Autonomy.AuditLine, { onExcessProperty: "error" })

  test("all three kinds of line have the agreed shape and nothing beyond it", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(root, decision())
        yield* service.record(root, { type: "outcome", requestID: "per_1", outcome: "ran", exit: 0, by: "person" })
        yield* service.record(root, { type: "marker", directory, marker: "b0", decidedBy: "system:queue_full" })
      }),
    )
    const written = lines()
    written.forEach((line) => expect(Exit.isSuccess(decode(line))).toBe(true))
    expect(written[0]).toMatchObject({
      v: 1,
      seq: 1,
      prev: null,
      type: "decision",
      rootID: root,
      sessionID: "ses_child",
      requestID: "per_1",
      messageID: "msg_1",
      callID: "call_1",
      agent: "general",
      rootAgent: "build",
      directory,
      permission: "bash",
      patterns: ["bun test test/a.test.ts"],
      patternsTruncated: false,
      class: "P",
      category: "check",
      risk: null,
      canUndo: true,
      decidedBy: "agent:gsp-ai-tail/thinker",
      decision: "allow",
      reason: "a local test run",
      memo: false,
      latencyMs: 2100,
      costUsd: 0,
      follows: [],
    })
    expect(typeof written[0].at).toBe("number")
    expect(written[1]).toMatchObject({ seq: 2, type: "outcome", outcome: "ran", exit: 0, by: "person" })
    expect(written[2]).toMatchObject({ seq: 3, type: "marker", marker: "b0" })
  })

  test("values outside the closed lists do not pass", () => {
    const chain = { v: 1, seq: 1, prev: null, at: 1 }
    const outcome = { ...chain, type: "outcome", requestID: "per_1" }
    expect(Exit.isSuccess(decode({ ...outcome, outcome: "ran" }))).toBe(true)
    expect(Exit.isSuccess(decode({ ...outcome, outcome: "maybe" }))).toBe(false)
    expect(Exit.isSuccess(decode({ ...outcome, outcome: "ran", by: "somebody" }))).toBe(false)
    expect(Exit.isSuccess(decode({ ...outcome, outcome: "ran", prev: "short" }))).toBe(false)
    expect(Exit.isSuccess(decode({ ...outcome, outcome: "ran", diff: "x" }))).toBe(false)
  })

  test("U11 fields, the archived outcome and the new markers are written and read back", async () => {
    const hash = sha("script")
    const moved = Array.from({ length: 40 }, (_, index) => ({ from: `src/${"a".repeat(140)}${index}`, to: `to/${"b".repeat(140)}${index}` }))
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(
          root,
          decision({
            class: "A",
            category: "script",
            via: "consent",
            duplicateOf: "per_0",
            consentID: "con_1",
            attempts: 2,
            script: { bytes: 12, sha: hash, flags: ["network", "rm"] },
          }),
        )
        yield* service.record(root, { type: "outcome", requestID: "per_2", outcome: "archived", archive: "arc_1", moved: [{ from: "a.txt", to: ".swarm/archive/arc_1/a.txt" }], bytes: 5, directory })
        yield* service.record(root, { type: "outcome", requestID: "per_3", outcome: "archived", archive: "arc_2", moved, bytes: 9, directory })
        for (const marker of ["consent_shown", "consent_given", "consent_cleared", "archive_emptied", "credential_snapshot", "subagent_stopped", "force_stop"] as const)
          yield* service.record(root, { type: "marker", marker, decidedBy: "gate" })
      }),
    )
    const written = lines()
    const decode = Schema.decodeUnknownExit(Autonomy.AuditLine, { onExcessProperty: "error" })
    written.forEach((line) => expect(Exit.isSuccess(decode(line))).toBe(true))
    expect(written[0]).toMatchObject({ via: "consent", duplicateOf: "per_0", consentID: "con_1", attempts: 2, category: "script", script: { bytes: 12, sha: hash, flags: ["network", "rm"] } })
    expect(written[1]).toMatchObject({ outcome: "archived", archive: "arc_1", bytes: 5, moved: [{ from: "a.txt", to: ".swarm/archive/arc_1/a.txt" }] })
    expect(written[1]).not.toHaveProperty("directory")
    expect(written[2].moved.length).toBeLessThan(40)
    expect(raw().every((line) => Buffer.byteLength(line) < 4096)).toBe(true)
    const read = await run((service) => service.readAudit(root))
    expect(read.problems).toEqual([])
    expect(read.lines.length).toBe(10)
  })

  test("row 150: a real move records its archived line through Autonomy.record, on the same chain", async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), "swarm-archive-"))
    try {
      writeFileSync(path.join(work, "old.txt"), "gone\n")
      const result = await run((service) =>
        Effect.gen(function* () {
          yield* service.record(root, decision())
          return yield* Effect.promise(() =>
            Archive.move({
              directory: work,
              paths: ["old.txt"],
              requestID: "per_9",
              record: Autonomy.archiveRecorder(service.record, { root, directory: work }),
            }),
          )
        }),
      )
      expect(result).toMatchObject({ ok: true, recorded: true })
      const written = lines()
      expect(written[1]).toMatchObject({ seq: 2, type: "outcome", requestID: "per_9", outcome: "archived", prev: sha(raw()[0]!) })
      expect(written[1].moved).toEqual([{ from: "old.txt", to: expect.stringMatching(/^\.swarm\/archive\/.+\/old\.txt$/) }])
      expect(written[1]).not.toHaveProperty("directory")
      expect((await run((service) => service.readAudit(root))).problems).toEqual([])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test("old lines without the new fields still decode", () => {
    const old = { v: 1, seq: 1, prev: null, at: 1, type: "outcome", requestID: "per_1", outcome: "ran" }
    expect(Exit.isSuccess(decode(old))).toBe(true)
    expect(Exit.isSuccess(decode({ ...old, outcome: "archived", moved: [{ from: "a" }] }))).toBe(false)
    expect(Exit.isSuccess(decode({ ...old, type: "decision", via: "other" }))).toBe(false)
  })

  test("1.1.1: bypassed, the main-agent via values and the bypass markers are written and read back", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(
          root,
          decision({
            class: "A",
            category: "by_main_agent",
            bypassed: "outward_not_in_mission",
            via: "main_agent",
            decidedBy: "agent:main/build",
          }),
        )
        yield* service.record(
          root,
          decision({ requestID: "per_2", class: "A", category: "by_main_agent", bypassed: "not_reversible", via: "for_subagent", decidedBy: "agent:main/build" }),
        )
        yield* service.record(root, decision({ requestID: "per_3", class: "X", category: "irreversible" }))
        yield* service.record(root, decision({ requestID: "per_4", class: "D", category: "outside_write_held" }))
        for (const marker of ["bypass_on", "bypass_report"] as const)
          yield* service.record(root, { type: "marker", directory, marker, decidedBy: "person" })
      }),
    )
    const written = lines()
    written.forEach((line) => expect(Exit.isSuccess(decode(line))).toBe(true))
    expect(written[0]).toMatchObject({ category: "by_main_agent", bypassed: "outward_not_in_mission", via: "main_agent", decidedBy: "agent:main/build" })
    expect(written[1]).toMatchObject({ bypassed: "not_reversible", via: "for_subagent" })
    expect(written[2]).toMatchObject({ class: "X", category: "irreversible" })
    expect(written[2]).not.toHaveProperty("bypassed")
    expect(written[3]).toMatchObject({ class: "D", category: "outside_write_held" })
    expect(written.slice(4).map((line) => line.marker)).toEqual(["bypass_on", "bypass_report"])
    const read = await run((service) => service.readAudit(root))
    expect(read).toMatchObject({ intact: true, problems: [] })
    expect(read.lines.length).toBe(6)
  })

  test("1.1.1 F26: the destination of a call the consent let out is written, read back and decodes; a line without it too", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(
          root,
          decision({
            class: "A",
            category: "by_main_agent",
            bypassed: "not_routine",
            via: "main_agent",
            decidedBy: "agent:main/build",
            patterns: ["curl -s http://localhost:3000/health"],
            destination: "localhost:3000",
          }),
        )
        yield* service.record(
          root,
          decision({
            requestID: "per_2",
            class: "A",
            category: "by_main_agent",
            bypassed: "outward_not_in_mission",
            via: "for_subagent",
            decidedBy: "agent:main/build",
            destination: "origin, registry.npmjs.org",
          }),
        )
        yield* service.record(root, decision({ requestID: "per_3" }))
      }),
    )
    const written = lines()
    written.forEach((line) => expect(Exit.isSuccess(decode(line))).toBe(true))
    expect(written[0]).toMatchObject({ destination: "localhost:3000", bypassed: "not_routine" })
    expect(written[1]).toMatchObject({ destination: "origin, registry.npmjs.org" })
    expect(written[2]).not.toHaveProperty("destination")
    const read = await run((service) => service.readAudit(root))
    expect(read).toMatchObject({ intact: true, problems: [] })
    expect(read.lines.map((line) => (line.type === "decision" ? line.destination : "-"))).toEqual([
      "localhost:3000",
      "origin, registry.npmjs.org",
      undefined,
    ])
    expect(Exit.isSuccess(decode({ ...written[0], destination: 7 }))).toBe(false)
  })

  test("1.1.1: every new category decodes, a 1.1.0 decision line still decodes, and bypassed stays a closed list", () => {
    const chain = { v: 1, seq: 1, prev: null, at: 1 }
    const old = {
      ...chain,
      type: "decision",
      rootID: root,
      sessionID: "ses_child",
      requestID: "per_1",
      agent: "general",
      directory,
      permission: "bash",
      patterns: ["bun test"],
      patternsTruncated: false,
      class: "P",
      category: "check",
      via: "grant",
      risk: null,
      canUndo: true,
      decidedBy: "gate",
      decision: "allow",
      memo: false,
      follows: [],
    }
    expect(Exit.isSuccess(decode(old))).toBe(true)
    for (const category of [
      "irreversible",
      "admin_rights",
      "outside_write_held",
      "system_service",
      "process_not_own",
      "unreadable_command",
      "by_main_agent",
    ]) {
      expect(Exit.isSuccess(decode({ ...old, category }))).toBe(true)
      expect(Exit.isSuccess(decode({ ...old, category: "by_main_agent", bypassed: category }))).toBe(true)
    }
    for (const via of ["main_agent", "for_subagent"]) expect(Exit.isSuccess(decode({ ...old, via }))).toBe(true)
    expect(Exit.isSuccess(decode({ ...old, bypassed: "anything" }))).toBe(false)
    const marker = { ...chain, type: "marker", rootID: root, decidedBy: "person" }
    expect(Exit.isSuccess(decode({ ...marker, marker: "mode_on" }))).toBe(true)
    expect(Exit.isSuccess(decode({ ...marker, marker: "bypass_on" }))).toBe(true)
    expect(Exit.isSuccess(decode({ ...marker, marker: "bypass_report" }))).toBe(true)
    expect(Exit.isSuccess(decode({ ...marker, marker: "bypass_off" }))).toBe(false)
  })

  test("1.1.1: the consent constant is the one value the register names", () => {
    expect(Autonomy.BYPASS_CONSENT).toBe("bypass-v1")
  })

  test("decidedBy tells the four deciders apart", async () => {
    const names = ["gate", "agent:gsp-ai-tail/thinker", "person", "system:decider_timeout"] as const
    await run((service) => Effect.forEach(names, (decidedBy) => service.record(root, decision({ decidedBy }))))
    expect(lines().map((line) => line.decidedBy)).toEqual([...names])
  })
})

describe("the file", () => {
  test("only its owner can read it, and a loose one is tightened", async () => {
    await run((service) => service.record(root, decision()))
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(statSync(folder).mode & 0o777).toBe(0o700)

    chmodSync(file(), 0o644)
    await run((service) => service.record(root, decision()))
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  test("a session ID cannot steer a line out of the folder", async () => {
    await run((service) => service.record("ses/../../audit_escaped" as SessionID, decision()))
    expect(existsSync(path.join(Global.Path.state, "audit_escaped.jsonl"))).toBe(false)
    expect(lines("audit_escaped")).toHaveLength(1)
  })

  test("a pipe in its place fails at once instead of blocking the prompt", async () => {
    mkdirSync(folder, { recursive: true })
    expect(Bun.spawnSync(["mkfifo", file()]).exitCode).toBe(0)
    await run((service) =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(service.record(root, decision())))).toBe(true)
        expect((yield* service.readAudit(root)).intact).toBe(false)
      }),
    )
  })

  test("a link in its place is not written through", async () => {
    mkdirSync(folder, { recursive: true })
    const elsewhere = path.join(mkdtempSync(path.join(os.tmpdir(), "audit-link-")), "target")
    writeFileSync(elsewhere, "")
    symlinkSync(elsewhere, file())
    await run((service) =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(service.record(root, decision())))).toBe(true)
      }),
    )
    expect(readlinkSync(file())).toBe(elsewhere)
    expect(readFileSync(elsewhere, "utf8")).toBe("")
    rmSync(path.dirname(elsewhere), { recursive: true, force: true })
  })

  test("a link put there after the first line is not written through either", async () => {
    const elsewhere = path.join(mkdtempSync(path.join(os.tmpdir(), "audit-link-")), "target")
    writeFileSync(elsewhere, "")
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(root, decision())
        rmSync(file())
        symlinkSync(elsewhere, file())
        expect(Exit.isFailure(yield* Effect.exit(service.record(root, decision())))).toBe(true)
      }),
    )
    expect(readFileSync(elsewhere, "utf8")).toBe("")
    rmSync(path.dirname(elsewhere), { recursive: true, force: true })
  })

  test("files past the retention go when the service starts, and only those", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(root, decision())
        yield* service.record(SessionID.make("ses_audit_old"), decision())
        yield* service.setMode({ scope: "session", root, on: true })
      }),
    )
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    const almost = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)
    utimesSync(file("ses_audit_old"), old, old)
    utimesSync(file(), almost, almost)
    // The mode file is as old as the rest and is not an audit file.
    utimesSync(path.join(folder, "mode.json"), old, old)
    await run(() => Effect.void)
    expect(existsSync(file("ses_audit_old"))).toBe(false)
    expect(existsSync(file())).toBe(true)
    expect(existsSync(path.join(folder, "mode.json"))).toBe(true)
  })
})

describe("line limit", () => {
  const bytes = (id?: string) =>
    readFileSync(file(id))
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => Buffer.byteLength(line))

  test("each list item and the reason are cut to their own limit", async () => {
    await run((service) =>
      service.record(root, decision({ patterns: ["a".repeat(301), "short"], reason: "r".repeat(500) })),
    )
    const line = lines()[0]
    expect(line.patterns[0]).toHaveLength(300)
    expect(line.patterns[1]).toBe("short")
    expect(line.patternsTruncated).toBe(true)
    expect(line.reason).toHaveLength(200)
  })

  test("no line reaches 4 KB, however wide its text, and it still names the request", async () => {
    const wide = "\u{1F600}".repeat(5000)
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(
          root,
          decision({
            sessionID: wide,
            agent: wide,
            rootAgent: wide,
            permission: wide,
            directory: `/${wide}`,
            patterns: Array.from({ length: 50 }, () => wide),
            reason: wide,
            follows: [{ permission: wide, patterns: [wide, wide] }],
          }),
        )
        yield* service.record(root, { type: "marker", directory: `/${wide}`, marker: "b1", decidedBy: "gate" })
        const read = yield* service.readAudit(root)
        expect(read.intact).toBe(true)
        expect(read.lines).toHaveLength(2)
      }),
    )
    bytes().forEach((size) => expect(size + 1).toBeLessThanOrEqual(4096))
    expect(lines()[0]).toMatchObject({ requestID: "per_1", patternsTruncated: true, follows: [] })
  })

  test("ten ordinary patterns of full length fit whole", async () => {
    const patterns = Array.from({ length: 10 }, (_, index) => `${index}`.repeat(300))
    await run((service) => service.record(root, decision({ patterns })))
    expect(lines()[0].patterns).toEqual(patterns)
    expect(lines()[0].patternsTruncated).toBe(false)
  })
})

describe("what is written down", () => {
  test("every request is one line, whatever its class", async () => {
    const classes = ["A", "P", "D", "B", "X"] as const
    await run((service) =>
      Effect.forEach(classes, (item, index) =>
        service.record(root, decision({ class: item, requestID: `per_${index}` })),
      ),
    )
    expect(lines().map((line) => [line.class, line.requestID])).toEqual(
      classes.map((item, index) => [item, `per_${index}`]),
    )
  })

  test("a diff, a tool's output and the goal do not reach the file, even when passed along", async () => {
    const mark = "SYNTHETIC-MARK-7f3a"
    await run((service) =>
      service.record(root, {
        ...decision(),
        goal: mark,
        output: mark,
        prompt: mark,
        metadata: { diff: mark, filepath: mark },
        content: mark,
      } as Autonomy.AuditEntry),
    )
    expect(readFileSync(file(), "utf8")).not.toContain(mark)
    expect(lines()).toHaveLength(1)
  })

  describe("secrets", () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "audit-secrets-"))
    const fromEnv = "synthetic-env-value-41ac"
    const fromFile = "synthetic-file-value-93de"

    beforeEach(() => {
      process.env.AUDIT_TEST_API_KEY = fromEnv
      writeFileSync(path.join(project, ".env"), `AUDIT_FILE_TOKEN=${fromFile}\n`)
    })
    afterEach(() => {
      delete process.env.AUDIT_TEST_API_KEY
      rmSync(path.join(project, ".env"), { force: true })
    })

    test("known values and values typed into a command are hidden, in every place a pattern goes", async () => {
      const typed = "API_KEY=syntheticTyped123"
      await run((service) =>
        service.record(
          root,
          decision({
            directory: project,
            patterns: [`curl -H ${fromEnv} x`, `echo ${fromFile}`, `${typed} bun test`],
            reason: `saw ${fromEnv}`,
            follows: [{ permission: "external_directory", patterns: [`cat ${fromFile}`, typed] }],
          }),
        ),
      )
      const text = readFileSync(file(), "utf8")
      expect(text).not.toContain(fromEnv)
      expect(text).not.toContain(fromFile)
      expect(text).not.toContain("syntheticTyped123")
      expect(lines()[0].patterns[0]).toContain("[hidden:AUDIT_TEST_API_KEY]")
    })

    test("a value cut in half by the limit was already hidden", async () => {
      await run((service) =>
        service.record(root, decision({ directory: project, patterns: [`${"x".repeat(295)} ${fromEnv}`] })),
      )
      expect(readFileSync(file(), "utf8")).not.toContain(fromEnv.slice(0, 3))
    })
  })

  test("a pattern stays on its one line, with hidden characters gone and Markdown left as text", async () => {
    await run((service) =>
      service.record(root, decision({ patterns: ['echo a\n{"type":"forged"}\r‮b', "[x](http://y) **z**"] })),
    )
    expect(raw()).toHaveLength(1)
    expect(lines()[0].patterns[0]).not.toContain("‮")
    expect(lines()[0].patterns[0]).not.toContain("\n")
    expect(lines()[0].patterns[1]).toBe("[x](http://y) **z**")
  })
})

describe("a question passed over", () => {
  const skipped = (over: Partial<Autonomy.SkippedQuestion> = {}) =>
    ({
      root,
      sessionID: SessionID.make("ses_child"),
      directory,
      agent: "general",
      messageID: "msg_1",
      callID: "call_1",
      questions: ["Which database should this use?"],
      ...over,
    }) satisfies Autonomy.SkippedQuestion

  test("is one line, settled by the gate, on the agent's assumption", async () => {
    await run((service) => service.recordSkippedQuestion(skipped()))
    const written = lines()
    expect(written).toHaveLength(1)
    expect(Exit.isSuccess(Schema.decodeUnknownExit(Autonomy.AuditLine)(written[0]))).toBe(true)
    expect(written[0]).toMatchObject({
      type: "decision",
      rootID: root,
      sessionID: "ses_child",
      requestID: "call_1",
      messageID: "msg_1",
      callID: "call_1",
      agent: "general",
      permission: "question",
      patterns: ["Which database should this use?"],
      class: "A",
      decidedBy: "gate",
      decision: "defer",
      reason: "asumsi agen",
      canUndo: false,
    })
  })

  test("takes its place in the same chain as every other line", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(root, decision())
        yield* service.recordSkippedQuestion(skipped())
        yield* service.record(root, decision({ requestID: "per_2" }))
        expect(yield* service.readAudit(root)).toMatchObject({ intact: true, notFromHere: 0 })
      }),
    )
    const text = raw()
    expect(lines().map((line) => line.seq)).toEqual([1, 2, 3])
    expect(lines().map((line) => line.prev)).toEqual([null, sha(text[0]), sha(text[1])])
  })

  test("a change to its line is detected like any other", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.recordSkippedQuestion(skipped())
        yield* Effect.sync(() => writeFileSync(file(), readFileSync(file(), "utf8").replace("asumsi agen", "person")))
        expect((yield* service.readAudit(root)).intact).toBe(false)
      }),
    )
  })

  test("a call without an ID still names its message", async () => {
    await run((service) => service.recordSkippedQuestion(skipped({ callID: undefined })))
    expect(lines()[0]).toMatchObject({ requestID: "msg_1", messageID: "msg_1" })
    expect(lines()[0].callID).toBeUndefined()
  })

  test("an answer does not reach the file, and a secret in the question is hidden", async () => {
    const answer = "SYNTHETIC-ANSWER-5b1c"
    await run((service) =>
      service.recordSkippedQuestion({
        ...skipped({ questions: ["Is API_KEY=syntheticAsked456 still valid?"] }),
        answers: [[answer]],
        answer,
        options: [{ label: answer, description: answer }],
      } as Autonomy.SkippedQuestion),
    )
    const text = readFileSync(file(), "utf8")
    expect(text).not.toContain(answer)
    expect(text).not.toContain("syntheticAsked456")
    expect(lines()[0].patterns[0]).toContain("[hidden:API_KEY]")
  })

  test("a failure reaches the caller", async () => {
    mkdirSync(file(), { recursive: true })
    await run((service) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(service.recordSkippedQuestion(skipped()))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })
})

describe("mode markers", () => {
  const marks = () => (existsSync(file()) ? lines().map((line) => line.marker) : [])
  const at = { root, directory }

  test("a root that was never on writes nothing", async () => {
    await run((service) => service.markMode(at))
    expect(existsSync(file())).toBe(false)
  })

  test("one marker per change, whichever scope made it, and none while nothing changes", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        yield* service.markMode(at)
        yield* service.markMode(at)
        yield* service.setMode({ scope: "session", root, on: false })
        yield* service.markMode(at)
        yield* service.setMode({ scope: "directory", directory, on: true })
        yield* service.markMode({ root: SessionID.make("ses_audit_b"), directory })
      }),
    )
    expect(marks()).toEqual(["mode_on", "mode_off"])
    expect(lines("ses_audit_b").map((line) => line.marker)).toEqual(["mode_on"])
  })

  test("a marker that could not be written is tried again", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* service.setMode({ scope: "session", root, on: true })
        mkdirSync(file())
        yield* service.markMode(at)
        rmSync(file(), { recursive: true })
        yield* service.markMode(at)
      }),
    )
    expect(marks()).toEqual(["mode_on"])
  })
})

describe("chain", () => {
  const three = (service: Autonomy.Interface) =>
    Effect.forEach(["per_1", "per_2", "per_3"], (requestID) => service.record(root, decision({ requestID })))

  const rewrite = (change: (current: string[]) => string[]) =>
    writeFileSync(
      file(),
      change(raw())
        .map((line) => `${line}\n`)
        .join(""),
    )

  const tampered = (change: (current: string[]) => string[]) =>
    run((service) =>
      Effect.gen(function* () {
        yield* three(service)
        expect(yield* service.readAudit(root)).toMatchObject({ intact: true, problems: [], notFromHere: 0 })
        yield* Effect.sync(() => rewrite(change))
        return yield* service.readAudit(root)
      }),
    )

  const edit = (line: string) => line.replace('"allow"', '"reject"')

  test("each line holds the hash of the one before it", async () => {
    await run(three)
    const text = raw()
    const written = lines()
    expect(written.map((line) => line.seq)).toEqual([1, 2, 3])
    expect(written.map((line) => line.prev)).toEqual([null, sha(text[0]), sha(text[1])])
  })

  describe("ADV-A23: a change while the process lives is detected", () => {
    test("a line in the middle edited", async () => {
      const read = await tampered((all) => [all[0], edit(all[1]), all[2]])
      expect(read.intact).toBe(false)
      expect(read.problems).toContain("line 3 follows a line that is not there")
    })

    test("the last line edited", async () => {
      const read = await tampered((all) => [all[0], all[1], edit(all[2])])
      expect(read.intact).toBe(false)
      expect(read.problems).toEqual(["the last line written here is gone or changed"])
    })

    test("the first line removed", async () => {
      expect((await tampered((all) => all.slice(1))).intact).toBe(false)
    })

    test("a line in the middle removed", async () => {
      const read = await tampered((all) => [all[0], all[2]])
      expect(read.problems).toContain("line 2 follows a line that is not there")
    })

    test("the tail cut off", async () => {
      expect((await tampered((all) => all.slice(0, 2))).intact).toBe(false)
    })

    test("two lines swapped", async () => {
      expect((await tampered((all) => [all[1], all[0], all[2]])).intact).toBe(false)
    })

    test("a line repeated", async () => {
      const read = await tampered((all) => [all[0], all[0], all[1], all[2]])
      expect(read.problems).toContain("line 2 repeats an earlier line")
    })

    test("a line that is not an entry", async () => {
      const read = await tampered((all) => [...all, "not json"])
      expect(read.problems).toContain("line 4 is not a valid entry")
    })

    test("the whole file rewritten with a chain that holds", async () => {
      const read = await tampered((all) =>
        all.map(edit).reduce<string[]>((out, line, index) => {
          const parsed = JSON.parse(line)
          return [...out, JSON.stringify({ ...parsed, prev: index === 0 ? null : sha(out[index - 1]) })]
        }, []),
      )
      expect(read.problems).toEqual(["the last line written here is gone or changed"])
    })

    test("the file removed", async () => {
      await run((service) =>
        Effect.gen(function* () {
          yield* three(service)
          rmSync(file())
          expect((yield* service.readAudit(root)).intact).toBe(false)
        }),
      )
    })

    test("a second line that claims to be the first, without being number one", async () => {
      const read = await tampered((all) => [...all.slice(0, 2), JSON.stringify({ ...JSON.parse(all[2]), prev: null })])
      expect(read.problems).toContain("line 3 claims to be the first")
    })

    test("a line forged onto the head is counted, not passed over", async () => {
      const read = await tampered((all) => {
        const forged = { ...JSON.parse(all[2]), seq: 4, prev: sha(all[2]), requestID: "per_forged" }
        return [...all, JSON.stringify(forged)]
      })
      expect(read.intact).toBe(true)
      expect(read.notFromHere).toBe(1)
    })

    test("writing on after a change does not hide it, in this process or the next", async () => {
      await run((service) =>
        Effect.gen(function* () {
          yield* three(service)
          yield* Effect.sync(() => rewrite((all) => [all[0], edit(all[1]), all[2]]))
          yield* service.record(root, decision({ requestID: "per_4" }))
          expect((yield* service.readAudit(root)).intact).toBe(false)
        }),
      )
      await run((service) =>
        Effect.gen(function* () {
          expect((yield* service.readAudit(root)).intact).toBe(false)
        }),
      )
    })
  })

  test("a new process continues the chain, and cannot know of a change made before it started", async () => {
    await run(three)
    rewrite((all) => [all[0], all[1], edit(all[2])])
    await run((service) =>
      Effect.gen(function* () {
        // The stated limit of this record: code running as the user can do this between two processes.
        expect((yield* service.readAudit(root)).intact).toBe(true)
        yield* service.record(root, decision({ requestID: "per_4" }))
        expect((yield* service.readAudit(root)).intact).toBe(true)
      }),
    )
    const text = raw()
    expect(lines()[3]).toMatchObject({ seq: 4, prev: sha(text[2]) })
  })

  test("a line left half written does not swallow the next one, and shows", async () => {
    await run(three)
    writeFileSync(file(), `${readFileSync(file(), "utf8")}{"v":1,"seq":4,"pr`)
    await run((service) =>
      Effect.gen(function* () {
        yield* service.record(root, decision({ requestID: "per_5" }))
        const read = yield* service.readAudit(root)
        expect(read.intact).toBe(false)
        expect(read.problems).toEqual(["line 4 is not a valid entry"])
        expect(read.lines.at(-1)).toMatchObject({ requestID: "per_5" })
      }),
    )
  })
})

describe("writers at the same time", () => {
  test("many requests in one process take one place each in the chain", async () => {
    await run((service) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 200 }, (_, index) => `per_${index}`),
          (requestID) => service.record(root, decision({ requestID })),
          { concurrency: "unbounded" },
        )
        expect(yield* service.readAudit(root)).toMatchObject({ intact: true, notFromHere: 0 })
      }),
    )
    expect(lines().map((line) => line.seq)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1))
  })

  // The hypothesis of GATE 8.1: on this file system an appended line under 4 KB from one process does not mix with
  // another's. Each writer is a real process, and its lines are as long as the limit allows, which is where it would show.
  test("whole lines from several processes do not mix, at the longest a line can be", async () => {
    const writers = 6
    const each = 150
    const module = path.resolve(import.meta.dir, "../../src/permission/autonomy.ts")
    const script = `
      const { Autonomy } = await import(process.env.AUTONOMY_MODULE)
      const { Global } = await import("@opencode-ai/core/global")
      const { Effect } = await import("effect")
      // Never against a real state folder.
      if (Global.Path.state !== process.env.EXPECTED_STATE) process.exit(3)
      await Effect.runPromise(Effect.gen(function* () {
        const service = yield* Autonomy.Service
        for (let index = 0; index < Number(process.env.EACH); index++) {
          yield* service.record(process.env.ROOT, {
            type: "decision", sessionID: "s", requestID: process.env.WRITER + "-" + index, agent: "a",
            directory: "/abs/project", permission: "bash", canUndo: false, class: "P", decidedBy: "gate",
            decision: "allow",
            patterns: [...Array.from({ length: 12 }, () => process.env.WRITER.repeat(300)), process.env.WRITER.repeat(150)],
          })
        }
      }).pipe(Effect.provide(Autonomy.layer)))
    `
    const started = Array.from({ length: writers }, (_, index) =>
      Bun.spawn([process.execPath, "-e", script], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          AUTONOMY_MODULE: module,
          EXPECTED_STATE: Global.Path.state,
          ROOT: root,
          EACH: String(each),
          WRITER: String.fromCharCode(97 + index),
        },
        stderr: "inherit",
      }),
    )
    const finished = Promise.all(started.map((item) => item.exited))
    // A reader in the middle of it, as Activity is while a run goes on: it must not take a write in flight for damage.
    const watch = async (running: { value: boolean }, seen: string[]): Promise<string[]> => {
      if (!running.value) return seen
      const read = await run((service) => service.readAudit(root))
      await Bun.sleep(2)
      return watch(running, [...seen, ...read.problems])
    }
    const running = { value: true }
    const watched = watch(running, [])
    const codes = await finished
    running.value = false
    expect(codes).toEqual(Array(writers).fill(0))
    expect(await watched).toEqual([])

    const text = raw()
    expect(text).toHaveLength(writers * each)
    // Close to the limit, or this says nothing about the limit.
    expect(Math.max(...text.map((line) => Buffer.byteLength(line)))).toBeGreaterThan(3990)
    text.forEach((line) => expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(4096))
    const written = lines()
    written.forEach((line) => {
      // Mixed writes would leave another writer's letter inside a pattern, or JSON that does not parse at all.
      const letter = line.requestID[0]
      line.patterns.forEach((pattern: string) => expect(pattern).toBe(letter.repeat(pattern.length)))
    })
    expect(new Set(written.map((line) => line.requestID)).size).toBe(writers * each)
    const read = await run((service) => service.readAudit(root))
    expect(read.problems).toEqual([])
    expect(read.intact).toBe(true)
  }, 120_000)
})
