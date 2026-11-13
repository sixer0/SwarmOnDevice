// Swarm 1.1.3 row 8 (masterplan/01_specs.md section 2 and section 7, "Row 8 (matrix)"): one case per matrix row 1-55,
// through the real gate (`Permission.ask`, src/permission/index.ts) and, unless the row says otherwise, the real table. Each
// case asserts the class, the decision, `category` / `bypassed`, the exact text the agent gets (`toBe` against the register
// constant), and the end-report section the decision line lands in (`AutonomyReport.render` over the root's own audit).
// Rows 9, 10, 49 and 54 assert "not produced" or "judged afresh". The run rows are checked for the root and, through the
// main agent, for a subagent. Texts for credential_change and admin_rights carry the T6 suffix (decisions.md T6).
import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test"
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import type { AutonomyDecider } from "../../src/permission/autonomy-decider"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import {
  ADMIN_RIGHTS_TEXT,
  ARCHIVE_FIRST_TEXT,
  CONSENT_CONTINUE_SUFFIX,
  CREDENTIAL_CHANGE_TEXT,
  DELETE_COMPOUND_TEXT,
  IRREVERSIBLE_ARCHIVE_TEXT,
  MAIN_AGENT_UNAVAILABLE_TEXT,
  OUTSIDE_WRITE_TEXT,
  OWN_API_TEXT,
  PROTECTED_PATH_TEXT,
  SPEND_STOPPED_TEXT,
  UNJUDGED_TEXT,
  checkpointFailedText,
  mainAgentDeclined,
  subagentStoppedMessage,
} from "../../src/permission/autonomy-texts"
import { ScriptReader } from "../../src/permission/script-reader"
import { APP_STATE, PLAN_MODE } from "./consented-literals"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { AutonomyReport } from "../../src/session/autonomy-report"
import { readSteps } from "../../src/tool/shell"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { expectNoManifestAbove } from "./install-fixture"

// ---------------------------------------------------------------------------------------------------------------------
// The oracle's texts (spec section 1 and section 2 "Agent answer"; T6 for the suffix).
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `RefusedByModeError` (index.ts): copied here on purpose, so a change of the text fails this test. 1.2.6 row 39 (P-01d,
 * INTENT f113-matrix.test.ts:696 per 01g 3.6): rows 12-13 and the gate's NEVER_OPENED plan_mode/app_state now get their
 * own texts (`PLAN_MODE`, `APP_STATE` in consented-literals.ts); this text is left for an X with no category.
 */
const REFUSED_BY_MODE_TEXT =
  "This call did not run. Autonomous mode never allows this kind of call, whoever is asked. Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list what was refused in your final message."
const CREDENTIAL_CONSENTED = `${CREDENTIAL_CHANGE_TEXT} ${CONSENT_CONTINUE_SUFFIX}`
const ADMIN_CONSENTED = `${ADMIN_RIGHTS_TEXT} ${CONSENT_CONTINUE_SUFFIX}`

/** The report's sections (spec section 2 legend), by their English headings. */
const SECTIONS = {
  M: "Decided by the main agent",
  O: "Sent outside the computer",
  Ar: "Moved to the archive",
  Rd: "Redirected to the archive method",
  F: "Refused",
  W: "Still waiting for you",
  I: "Open issues",
} as const
type Section = keyof typeof SECTIONS

// ---------------------------------------------------------------------------------------------------------------------
// Harness: the gate with the session, the audit and the decider seam (as autonomy-bypass-gate.test.ts builds it).
// ---------------------------------------------------------------------------------------------------------------------

const folder = path.join(Global.Path.state, "autonomy")

type DeciderCall = { sessionID: string; permission: string; category?: string; options?: AutonomyDecider.Options }
const stub = {
  calls: [] as DeciderCall[],
  answer: (): Effect.Effect<Permission.Decided> =>
    Effect.succeed({ decision: "allow", decidedBy: "agent:test/stub", reason: "fine" }),
}
const decider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: (input, _root, category, _script, options) =>
      Effect.suspend(() => {
        stub.calls.push({ sessionID: input.sessionID, permission: input.permission, category, options })
        return stub.answer()
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

const clean = () => {
  if (existsSync(folder)) chmodSync(folder, 0o755)
  rmSync(folder, { recursive: true, force: true })
  rmSync(path.join(Global.Path.state, "trust.json"), { force: true })
}
beforeEach(() => {
  clean()
  stub.calls.length = 0
  stub.answer = () => Effect.succeed({ decision: "allow", decidedBy: "agent:test/stub", reason: "fine" })
})
afterEach(clean)
afterAll(() => {
  if (process.env.F113_SUMMARY) console.log(`cross-listed (${crossListed.length}):\n${crossListed.join("\n")}`)
})

const say = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("free") },
    } satisfies SessionV1.User)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "text",
      text: "fix the build",
    } satisfies SessionV1.TextPart)
  })

const family = (consent = true) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* say(root.id)
    const child = yield* sessions.create({ parentID: root.id })
    yield* autonomy.setMode({
      scope: "session",
      root: root.id,
      on: true,
      ...(consent && { bypassConsent: "bypass-v1" as const, reportLanguage: "en" as const }),
    })
    return { root, child }
  })

/** The project: a git repository with a manifest, sources, a secret, a script and a file to replace. */
function populate(dir: string) {
  mkdirSync(path.join(dir, "src"), { recursive: true })
  writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  writeFileSync(path.join(dir, "src/b.ts"), "y\n")
  writeFileSync(path.join(dir, ".env"), "TOKEN=1\n")
  writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\nls\n")
  expectNoManifestAbove(dir)
  writeFileSync(path.join(dir, "package.json"), "{}\n")
}

type Call = {
  permission: string
  patterns?: readonly string[]
  metadata?: Record<string, unknown>
  editClass?: PermissionV1.EditClass
  canUndo?: boolean
  plan?: boolean
  catchAll?: boolean
  follows?: readonly { permission: string; patterns: readonly string[] }[]
}
const bash = (command: string, metadata: Record<string, unknown> = {}, extra: Partial<Call> = {}): Call => ({
  permission: "bash",
  patterns: [command],
  metadata: { command, ...metadata },
  ...extra,
})

const ask = (call: Call, sessionID: SessionID, dir: string) =>
  Effect.gen(function* () {
    const command = call.metadata?.command
    const steps = call.permission === "bash" && typeof command === "string" ? yield* Effect.promise(() => readSteps(command, dir)) : undefined
    const metadata = call.permission === "bash" ? { ...call.metadata, workdir: dir, ...(steps ? { steps } : {}) } : (call.metadata ?? {})
    return {
      id: PermissionV1.ID.ascending(),
      sessionID,
      permission: call.permission,
      patterns: call.patterns ?? ["*"],
      metadata,
      always: ["*"],
      ruleset: call.catchAll ? [{ permission: "*", pattern: "*", action: "ask" as const }] : [],
      canUndo: call.canUndo ?? true,
      agent: call.plan ? "plan" : "general",
      ...(call.editClass && { editClass: call.editClass }),
      ...(call.follows && { follows: call.follows }),
    } satisfies PermissionV1.AskInput
  })

type Wrap = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
type Outcome = { readonly ran: true } | { readonly waited: string } | { readonly text: string }
const RAN: Outcome = { ran: true }
const settle = (input: PermissionV1.AskInput, wrap: Wrap = (self) => self) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* wrap(permission.ask(input)).pipe(Effect.as("ran" as const), Effect.timeoutOption("3 seconds"), Effect.exit)
    if (Exit.isSuccess(exit)) return Option.isSome(exit.value) ? RAN : { waited: "no answer in 3 s" }
    const failure = Cause.squash(exit.cause)
    if (failure instanceof PermissionV1.DeferredError) return { waited: `DeferredError ${failure.category}` }
    if (failure instanceof PermissionV1.AwayError) return { waited: "AwayError" }
    return { text: failure instanceof Error ? failure.message : String(failure) }
  }) as Effect.Effect<Outcome, never, Permission.Service>

const audit = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    return (yield* autonomy.readAudit(root)).lines
  })

/** The sections of the root's end report that list anything, rendered by the real `AutonomyReport.render`. */
const sectionsOf = (root: SessionID, dir: string) =>
  Effect.gen(function* () {
    const lines = yield* audit(root)
    const decisions = lines.flatMap((line) => (line.type === "decision" ? [line] : []))
    const report = AutonomyReport.render({
      run: { root, directory: dir, since: 0, until: Date.now(), language: "en" },
      lines,
      open: [],
      goal: [],
      files: [],
      todos: [],
      attached: [],
      skipped: [],
      sends: AutonomyReport.sendsOf(decisions, dir),
    })
    const bodies = new Map(
      report.split("\n## ").slice(1).map((part) => {
        const [heading, ...rest] = part.split("\n")
        return [heading!.trim(), rest.join("\n").trim()] as const
      }),
    )
    const listed = (Object.keys(SECTIONS) as Section[]).filter((key) => {
      const body = bodies.get(SECTIONS[key])
      if (body === undefined) throw new Error(`no section "${SECTIONS[key]}" in the report`)
      return body !== "None."
    })
    return { listed, outward: bodies.get(SECTIONS.O) ?? "" }
  })

/**
 * Cross-listings the 1.1.1 report makes beside the section a line lands in, kept apart from the matrix's section so that
 * one stays exact: O lists every send of the run, or one that would have been (P42), with what became of it; M lists every
 * call the main agent was asked about (`via` "for_subagent"). Each is accepted only when it agrees with the line, and is
 * collected for the row 8 report (F113_SUMMARY=1 prints them).
 */
const crossListed: string[] = []

const pending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* permission.list()
})

type LineWant = {
  class: string
  category?: string
  bypassed?: string
  decision: "allow" | "reject"
  /** "present": a non-empty destination on the line (spec "A + destination"). */
  destination?: "present"
  decidedBy?: string
}
type Want = {
  /** The agent's answer: RAN, or the exact text. */
  answer: "ran" | string
  line: LineWant
  sections: readonly Section[]
}

/**
 * One matrix case in a family of its own, so the root's report holds this call alone: the answer, the one decision line
 * and its fields, nothing pending, and the report's sections.
 */
const check = (
  name: string,
  call: Call,
  want: Want,
  options: { caller?: "root" | "subagent"; wrap?: Wrap; after?: (root: SessionID, id: string) => Effect.Effect<void, unknown, Autonomy.Service> } = {},
) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const { root, child } = yield* family()
    const waiting = (yield* pending).length
    const input = yield* ask(call, options.caller === "subagent" ? child.id : root.id, test.directory)
    const outcome = yield* settle(input, options.wrap)
    const lines = (yield* audit(root.id)).flatMap((line) => (line.type === "decision" ? [line] : []))
    const line = lines.find((item) => item.requestID === input.id)
    if (options.after) yield* options.after(root.id, input.id!)
    const report = yield* sectionsOf(root.id, test.directory)
    const extra: string[] = []
    const sections = report.listed.filter((section) => {
      if (want.sections.includes(section) || !line) return true
      if (section === "O") {
        const verdict = line.decision === "allow" ? " · ran · " : " · refused · "
        if (!report.outward.includes(verdict)) return true
        extra.push(`O (${verdict.trim().replaceAll("·", "").trim()})`)
        return false
      }
      if (section === "M" && line.via === "for_subagent") {
        extra.push(`M (via for_subagent, decidedBy ${line.decidedBy})`)
        return false
      }
      return true
    })
    if (extra.length > 0) crossListed.push(`${name}: ${extra.join(", ")}`)
    if (process.env.F113_SUMMARY && want.sections.includes("O")) crossListed.push(`${name}: O row: ${report.outward}`)
    const got = {
      answer: "ran" in outcome ? "ran" : "text" in outcome ? outcome.text : `WAITED ${outcome.waited}`,
      lines: lines.length,
      line: line && {
        class: line.class,
        ...(want.line.category !== undefined || line.category !== undefined ? { category: line.category } : {}),
        ...(want.line.bypassed !== undefined || line.bypassed !== undefined ? { bypassed: line.bypassed } : {}),
        decision: line.decision,
        ...(want.line.destination ? { destination: line.destination ? "present" : line.destination } : {}),
        ...(want.line.decidedBy ? { decidedBy: line.decidedBy } : {}),
      },
      sections,
      pending: (yield* pending).length - waiting,
    }
    const wanted: Record<string, unknown> = { case: name, answer: want.answer, lines: 1, line: want.line, sections: [...want.sections], pending: 0 }
    expect({ case: name, ...got } as Record<string, unknown>).toEqual(wanted)
  })

/** Lays the real `noWait` over a base verdict, in place of the table (rows the table cannot reach on this machine). */
const viaNoWait =
  (base: AutonomyTable.Verdict): Wrap =>
  (self) =>
    self.pipe(Effect.provideService(Permission.Classify, (input) => AutonomyTable.noWait(input, base)))
/** The real table over the gate's input with one field changed (a folder state this fixture cannot have). */
const realTableWith =
  (change: Partial<AutonomyTable.Input>): Wrap =>
  (self) =>
    self.pipe(Effect.provideService(Permission.Classify, (input) => AutonomyTable.classify({ ...input, ...change })))
const forge =
  (verdict: Record<string, unknown>): Wrap =>
  (self) =>
    self.pipe(Effect.provideService(Permission.Classify, () => verdict as never))
const throwing: Wrap = (self) =>
  self.pipe(
    Effect.provideService(Permission.Classify, () => {
      throw new Error("boom")
    }),
  )

/** A run row: A `by_main_agent` with `bypassed`, report M (and O when it sends), for the root and for a subagent. */
const runs = (bypassed: string, sections: readonly Section[] = ["M"], destination = false) => ({
  root: {
    answer: "ran",
    line: { class: "A", category: "by_main_agent", bypassed, decision: "allow", ...(destination && { destination: "present" as const }) },
    sections,
  } satisfies Want,
  // a subagent's opened call goes to the main agent (index.ts S1.32-S1.33), which says yes here
  subagent: {
    answer: "ran",
    line: { class: "A", category: "by_main_agent", bypassed, decision: "allow", decidedBy: "agent:main/build", ...(destination && { destination: "present" as const }) },
    sections,
  } satisfies Want,
})
const answered = (text: string, cls: string, category: string, section: Section, bypassed?: string): Want => ({
  answer: text,
  line: { class: cls, category, ...(bypassed !== undefined && { bypassed }), decision: "reject" },
  sections: [section],
})

const both = (name: string, call: Call, want: ReturnType<typeof runs>, wrap?: Wrap) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    populate(test.directory)
    yield* Effect.promise(() => ScriptReader.prepare())
    yield* check(`${name} (root)`, call, want.root, { wrap })
    yield* check(`${name} (subagent)`, call, want.subagent, { caller: "subagent", wrap })
    // the decider only ever answered for the subagent, as the main agent, never as the class P decider
    expect(stub.calls.map((item) => item.options?.forSubagent !== undefined)).toEqual([true])
  })
/** A redirect or refusal row: the same answer for the root and for a subagent; the main agent is never asked. */
const refusedBoth = (name: string, call: Call, want: Want, wrap?: Wrap) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    populate(test.directory)
    yield* Effect.promise(() => ScriptReader.prepare())
    yield* check(`${name} (root)`, call, want, { wrap })
    yield* check(`${name} (subagent)`, call, want, { caller: "subagent", wrap })
    expect(stub.calls).toEqual([])
  })

// ---------------------------------------------------------------------------------------------------------------------
// Rows 1-23: what waited in 1.1.2 now runs (or is refused, rows 12-13, unchanged)
// ---------------------------------------------------------------------------------------------------------------------

describe("1.1.3 matrix rows 1-23: categories", () => {
  it.instance("row 1 outside_folder: runs, A bypassed outside_folder / M", () =>
    both("row 1", { permission: "external_directory", patterns: ["/tmp/*"], metadata: { filepath: "/tmp/f113-a" } }, runs("outside_folder")),
  )
  it.instance("row 2 outward (a remote host nobody named): runs, A + destination / O and M", () =>
    both("row 2", bash("curl https://x.example"), runs("outward", ["M", "O"], true)),
  )
  it.instance("row 3 not_reversible (a non-remote risk label, 1838): archive redirect, ARCHIVE_FIRST_TEXT / Rd", () =>
    refusedBoth("row 3", bash("ls -la", { risk: "irreversible" }), answered(ARCHIVE_FIRST_TEXT, "X", "not_reversible", "Rd", "not_reversible")),
  )
  it.instance("row 4 sensitive_file: runs / M", () =>
    both("row 4", { permission: "edit", patterns: ["package.json"], metadata: { filepath: "package.json" }, editClass: "sensitive" }, runs("sensitive_file")),
  )
  // 1.2.6 row 36 (U12, INTENT 01b 10.1 :426-427): a read of .env is no longer opened by the consent; it runs at the gate as
  // protected_read (row 5b). The secret_file row keeps its meaning through the write of the same file.
  it.instance("row 5 secret_file (the write of .env): runs / M", () =>
    both("row 5", { permission: "edit", patterns: [".env"], metadata: { filepath: ".env" }, editClass: "secret" }, runs("secret_file")),
  )
  it.instance("row 5b protected_read (the read of .env): runs at the gate, no section, the main agent is never asked", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      const call: Call = { permission: "read", patterns: [".env"], metadata: { filepath: ".env" } }
      const want: Want = { answer: "ran", line: { class: "A", category: "protected_read", decision: "allow" }, sections: [] }
      yield* check("row 5b (root)", call, want)
      yield* check("row 5b (subagent)", call, want, { caller: "subagent" })
      expect(stub.calls).toEqual([])
    }),
  )
  it.instance("row 6 external_tool (a tool that says nothing about itself): runs / M", () =>
    both("row 6", { permission: "graft_find_code", patterns: ["*"], metadata: {} }, runs("external_tool")),
  )
  it.instance("row 7 no_undo (a script with no Undo): runs / M", () =>
    both("row 7", bash(`python3 -c 'x = 1'`, {}, { canUndo: false }), runs("no_undo")),
  )
  // 1.2.7 U-7 (INTENT, C7/C21): `not_routine` is a local category, so a subagent's call runs like the root's: no decider.
  it.instance("row 8 not_routine (T1): runs / M", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      yield* Effect.promise(() => ScriptReader.prepare())
      const want = runs("not_routine")
      yield* check("row 8 (root)", bash("node x.js"), want.root)
      yield* check("row 8 (subagent)", bash("node x.js"), want.subagent, { caller: "subagent" })
      expect(stub.calls).toEqual([])
    }),
  )
  it.instance("row 11 folder_not_trusted (the folder state unreadable): runs / M", () =>
    both("row 11", bash("bun test"), runs("folder_not_trusted"), realTableWith({ folder: undefined })),
  )
  it.instance("row 12 plan_mode: refused (unchanged), its own text (1.2.6 row 39) / F", () =>
    refusedBoth("row 12", { permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "src/a.ts" }, editClass: "ordinary", plan: true }, answered(PLAN_MODE, "X", "plan_mode", "F")),
  )
  it.instance("row 13 app_state: refused (unchanged), its own text (1.2.6 row 39) / F", () =>
    refusedBoth("row 13", { permission: "edit", patterns: ["state"], metadata: { filepath: path.join(Global.Path.state, "autonomy", "x.json") } }, answered(APP_STATE, "X", "app_state", "F")),
  )
  it.instance("row 14 asks_every_time (a person's \"*\": \"ask\"): runs / M", () =>
    both("row 14", bash("ls -la", {}, { catchAll: true }), runs("asks_every_time")),
  )
  it.instance("row 15 outward_not_in_mission: runs, A + destination / O and M", () =>
    both("row 15", { permission: "webfetch", patterns: ["https://x.example/"], metadata: { url: "https://x.example/" } }, runs("outward_not_in_mission", ["M", "O"], true)),
  )
  it.instance("row 16 script_flagged without sudo or delete: runs / M", () =>
    both("row 16", bash(`python3 -c 'import urllib'`), runs("script_flagged")),
  )
  it.instance("row 17 script_unreadable (a script the shell did not hash): runs / M", () =>
    both("row 17", bash("./run.sh"), runs("script_unreadable")),
  )
  it.instance("row 18 program_not_trusted (base verdict through the real noWait): runs / M", () =>
    both("row 18", bash("mkdir x"), runs("program_not_trusted"), viaNoWait({ class: "D", decidedBy: "gate", category: "program_not_trusted" })),
  )
  it.instance("row 19 outside_write_held (a global install): runs / M", () =>
    both("row 19", bash("npm install -g left-pad"), runs("outside_write_held")),
  )
  it.instance("row 20 system_service: runs / M", () => both("row 20", bash("launchctl list"), runs("system_service")))
  it.instance("row 21 process_not_own: runs / M", () => both("row 21", bash("kill 4242"), runs("process_not_own")))
  it.instance("row 22 unreadable_command: runs / M", () => both("row 22", bash("eval ls"), runs("unreadable_command")))
  it.instance("row 23 outside_write (base X): runs, bypassed outside_write_held / M", () =>
    both("row 23", bash("echo x > /tmp/f113-outside.txt"), runs("outside_write_held")),
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// Rows 24-39: destructive classes
// ---------------------------------------------------------------------------------------------------------------------

describe("1.1.3 matrix rows 24-39: destructive classes", () => {
  it.instance("row 24 delete_compound: archive redirect, DELETE_COMPOUND_TEXT / Rd", () =>
    refusedBoth("row 24", bash("rm src/a.ts && ls"), answered(DELETE_COMPOUND_TEXT, "X", "delete_compound", "Rd")),
  )
  it.instance("row 25 credential_change (a remote added; a push to a non-remote, rule 2b): refusal + T6 suffix / F", () =>
    Effect.gen(function* () {
      for (const command of ["git remote add x https://github.com/evil/app.git", "git push /tmp/f113-elsewhere main"])
        yield* refusedBoth(`row 25 ${command}`, bash(command), answered(CREDENTIAL_CONSENTED, "X", "credential_change", "F"))
    }),
  )
  it.instance("row 26 irreversible: archive redirect, IRREVERSIBLE_ARCHIVE_TEXT / Rd", () =>
    refusedBoth("row 26", bash("git reset --hard"), answered(IRREVERSIBLE_ARCHIVE_TEXT, "X", "irreversible", "Rd")),
  )
  it.instance("row 27 admin_rights (sudo, doas, su, pkexec, run0, osascript admin): refusal + T6 suffix / F", () =>
    Effect.gen(function* () {
      for (const command of [
        "sudo ls",
        "doas ls",
        "su -c ls",
        "pkexec ls",
        "run0 ls",
        `osascript -e 'do shell script "ls" with administrator privileges'`,
      ])
        yield* refusedBoth(`row 27 ${command}`, bash(command), answered(ADMIN_CONSENTED, "X", "admin_rights", "F"))
    }),
  )
  it.instance("row 28 a plain deletion the shell archives: runs as a move (A archived); the shell's line lands in Ar", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      for (const caller of ["root", "subagent"] as const)
        yield* check(
          `row 28 (${caller})`,
          bash("rm src/a.ts", { archive: true }),
          { answer: "ran", line: { class: "A", category: "archived", decision: "allow" }, sections: ["Ar"] },
          {
            caller,
            // the outcome line shell.ts writes after the move (Autonomy.archiveRecorder); the gate's line alone is no section
            after: (root, id) =>
              Effect.gen(function* () {
                const autonomy = yield* Autonomy.Service
                yield* autonomy.record(root, { type: "outcome", requestID: id, outcome: "archived", moved: [{ from: "src/a.ts", to: ".swarm/archive/1/src/a.ts" }] })
              }),
          },
        )
      expect(stub.calls).toEqual([])
    }),
  )
  it.instance("row 29 a plain deletion the shell will not archive (1804): ARCHIVE_FIRST_TEXT / Rd", () =>
    refusedBoth("row 29", bash("rm src/a.ts"), answered(ARCHIVE_FIRST_TEXT, "X", "not_reversible", "Rd", "not_reversible")),
  )
  it.instance("row 30 cp or mv replacing a file not in archiveTargets (1234): ARCHIVE_FIRST_TEXT / Rd", () =>
    Effect.gen(function* () {
      for (const command of ["cp src/a.ts src/b.ts", "mv src/a.ts src/b.ts"])
        yield* refusedBoth(`row 30 ${command}`, bash(command), answered(ARCHIVE_FIRST_TEXT, "X", "not_reversible", "Rd", "not_reversible"))
    }),
  )
  it.instance("row 31 a D/P shell call where `destroys` is true: ARCHIVE_FIRST_TEXT / Rd", () =>
    refusedBoth("row 31", bash("truncate -s 0 src/a.ts"), answered(ARCHIVE_FIRST_TEXT, "X", "not_reversible", "Rd", "not_routine")),
  )
  it.instance("row 32 a `remote` risk label (793): runs, A bypassed outward / O and M", () =>
    both("row 32", bash("git push origin main", { risk: "remote" }), runs("outward", ["M", "O"])),
  )
  it.instance("row 33 the git list: archive redirect, IRREVERSIBLE_ARCHIVE_TEXT / Rd", () =>
    Effect.gen(function* () {
      for (const command of [
        "git reset --hard",
        "git clean -f",
        "git push --force origin main",
        "git branch -D old",
        "git rebase main",
        "git filter-branch --tree-filter true HEAD",
        "git update-ref -d refs/heads/old",
        "git reflog expire --expire=now --all",
        "git reflog delete HEAD@{1}",
        "git gc --prune=now",
        "git stash drop",
        "git stash clear",
      ])
        yield* refusedBoth(`row 33 ${command}`, bash(command), answered(IRREVERSIBLE_ARCHIVE_TEXT, "X", "irreversible", "Rd"))
    }),
  )
  // 1.2.6 row 37b (P-01b, INTENT per 01g 3.6): a database or a device is I-N, which no checkpoint of files can hold, so it
  // is refused `checkpoint_failed` with its reason (section F). A migrate wipe run through a package runner stays.
  it.instance("row 34 SQL or migrate wipe, dropdb: checkpoint_failed / F; a runner's migrate wipe: archive redirect / Rd", () =>
    Effect.gen(function* () {
      for (const command of ["psql -c 'DROP TABLE users'", "dropdb app"])
        yield* refusedBoth(`row 34 ${command}`, bash(command), answered(checkpointFailedText("not_files"), "X", "checkpoint_failed", "F"))
      yield* refusedBoth(
        "row 34 bunx prisma migrate reset --force",
        bash("bunx prisma migrate reset --force"),
        answered(IRREVERSIBLE_ARCHIVE_TEXT, "X", "irreversible", "Rd"),
      )
    }),
  )
  // 1.2.6 row 37b (INTENT per 01g 3.6): a disk wipe is I-N (`checkpoint_failed`, section F); host control and a file
  // shred with Undo on keep the remote-or-host text.
  it.instance("row 35 disk wipe: checkpoint_failed / F; host control and shred: archive redirect / Rd", () =>
    Effect.gen(function* () {
      for (const command of ["dd if=/dev/zero of=x.img", "mkfs.ext4 /dev/disk9", "wipefs -a /dev/disk9", "diskutil eraseDisk APFS X disk9"])
        yield* refusedBoth(`row 35 ${command}`, bash(command), answered(checkpointFailedText("not_files"), "X", "checkpoint_failed", "F"))
      for (const command of ["shred src/a.ts", "shutdown -h now", "reboot", "halt"])
        yield* refusedBoth(`row 35 ${command}`, bash(command), answered(IRREVERSIBLE_ARCHIVE_TEXT, "X", "irreversible", "Rd"))
    }),
  )
  it.instance("row 36 a script flagged `delete`: DELETE_COMPOUND_TEXT / Rd", () =>
    refusedBoth("row 36", bash(`python3 -c 'import os; os.remove("a")'`), answered(DELETE_COMPOUND_TEXT, "X", "delete_compound", "Rd", "script_flagged")),
  )
  it.instance("row 37 an SQL tool or diskutil with dynamic arguments (bypass-screen.ts:591): IRREVERSIBLE_ARCHIVE_TEXT / Rd", () =>
    Effect.gen(function* () {
      for (const command of ["psql $DATABASE_URL", "diskutil $DISK"])
        yield* refusedBoth(`row 37 ${command}`, bash(command), answered(IRREVERSIBLE_ARCHIVE_TEXT, "X", "irreversible", "Rd"))
    }),
  )
  it.instance("row 38 a script flagged `sudo`: ADMIN_RIGHTS_TEXT + T6 suffix / F", () =>
    refusedBoth("row 38", bash(`python3 -c 'm = "sudo ls"'`), answered(ADMIN_CONSENTED, "X", "admin_rights", "F", "script_flagged")),
  )
  it.instance("row 39 the patch tool's deletion (apply_patch.ts:285-357): its ordinary edit runs; its archived line lands in Ar", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      for (const caller of ["root", "subagent"] as const)
        yield* check(
          `row 39 (${caller})`,
          // as apply_patch.ts asks for a hunk that deletes src/a.ts inside the project
          { permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "src/a.ts", files: [] }, editClass: "ordinary" },
          { answer: "ran", line: { class: "A", decision: "allow" }, sections: ["Ar"] },
          {
            caller,
            after: (root, id) =>
              Effect.gen(function* () {
                const autonomy = yield* Autonomy.Service
                yield* autonomy.record(root, { type: "outcome", requestID: id, outcome: "archived", moved: [{ from: "src/a.ts", to: ".swarm/archive/2/src/a.ts" }] })
              }),
          },
        )
      expect(stub.calls).toEqual([])
    }),
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// Rows 40-49: the decider's outcomes. Root: never called (class P runs). Subagent: the main agent's refusal, unchanged.
// ---------------------------------------------------------------------------------------------------------------------

const HOLD_REASONS = ["no_model", "model_error", "timeout", "invalid_output", "queue_full", "circuit_open", "limit", "spend_stopped"] as const

describe("1.1.3 matrix rows 40-49: decider outcomes", () => {
  HOLD_REASONS.forEach((reason, index) =>
    it.instance(`row ${40 + index} ${reason}: root runs without the decider; subagent gets MAIN_AGENT_UNAVAILABLE_TEXT / I`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        populate(test.directory)
        stub.answer = () => Effect.succeed({ decision: "reject", decidedBy: "system:main_agent_unavailable", reason } as Permission.Decided)
        // the root's class P call (a check) and a not-routine call: the decider is never asked, the call runs
        yield* check(`row ${40 + index} root P`, bash("make build"), runs("check").root)
        yield* check(`row ${40 + index} root D`, bash("node x.js"), runs("not_routine").root)
        expect(stub.calls).toEqual([])
        // 1.2.7 U-7 (INTENT): `not_routine` and (row 29c, C41) `check` run like the root's for a subagent now, so a decided
        // category (`system_service`) is used.
        yield* check(`row ${40 + index} subagent`, bash("launchctl list"), {
          answer: MAIN_AGENT_UNAVAILABLE_TEXT,
          line: { class: "A", category: "by_main_agent", bypassed: "system_service", decision: "reject", decidedBy: "system:main_agent_unavailable" },
          sections: ["I"],
        }, { caller: "subagent" })
        expect(stub.calls.map((call) => call.options?.forSubagent !== undefined)).toEqual([true])
      }),
    ),
  )

  it.instance("row 48 needs_person: root not called; subagent rejected with mainAgentDeclined(reason), agent:main/... / M", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      // the decider maps needs_person to reject for a subagent (autonomy-decider.ts:302)
      stub.answer = () => Effect.succeed({ decision: "reject", decidedBy: "agent:test/stub", reason: "a person should look." } as Permission.Decided)
      yield* check("row 48 root", bash("make build"), runs("check").root)
      expect(stub.calls).toEqual([])
      // 1.2.7 U-7 (INTENT): a decided category (`system_service`); `not_routine` and (row 29c, C41) `check` run like the
      // root's for a subagent now.
      yield* check("row 48 subagent", bash("launchctl list"), {
        answer: mainAgentDeclined("a person should look."),
        line: { class: "A", category: "by_main_agent", bypassed: "system_service", decision: "reject", decidedBy: "agent:main/build" },
        sections: ["M"],
      }, { caller: "subagent" })
    }),
  )

  it.instance("row 49 decider exception (UNDECIDED): not reachable for the root; P runs and the decider is never called", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      stub.answer = () => Effect.die(new Error("decider exploded"))
      for (const [command, bypassed] of [["make build", "check"], ["node x.js", "not_routine"], ["launchctl list", "system_service"]])
        yield* check(`row 49 root ${command}`, bash(command), runs(bypassed).root)
      expect(stub.calls).toEqual([])
      // no line anywhere says decider_unavailable
    }),
  )

  it.instance("row 10 decider_unavailable: never produced, class P runs (section 3)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      stub.answer = () => Effect.succeed({ decision: "defer", decidedBy: "system:decider_unavailable", reason: "no_model" } as Permission.Decided)
      yield* check("row 10 root", bash("make build"), runs("check").root)
      // a base verdict of P with every category through the real noWait: none becomes decider_unavailable
      for (const category of PermissionV1.DeferredCategory.literals)
        yield* check(`row 10 P ${category}`, { permission: "graft_find_code", patterns: [category], metadata: {} }, noWaitWant(category), {
          wrap: viaNoWait({ class: "P", decidedBy: "agent", category }),
        })
      expect(stub.calls).toEqual([])
    }),
  )
})

/**
 * The gate's `NEVER_OPENED_X` (index.ts, S1.36) with each category's consented text and report section (Rd for the
 * `ARCHIVE_REDIRECT` ones, spec legend). A verdict that claims to have opened one of them is refused with that text.
 */
const NEVER_OPENED: Readonly<Record<string, readonly [string, Section]>> = {
  irreversible: [IRREVERSIBLE_ARCHIVE_TEXT, "Rd"],
  delete_compound: [DELETE_COMPOUND_TEXT, "Rd"],
  admin_rights: [ADMIN_CONSENTED, "F"],
  credential_change: [CREDENTIAL_CONSENTED, "F"],
  outside_write: [OUTSIDE_WRITE_TEXT, "F"],
  // Row 202: a secret or system place outside the project, refused with or without consent.
  protected_path: [PROTECTED_PATH_TEXT, "F"],
  // 1.2.6 row 39 (P-01d, INTENT): their own texts, not the general refusal.
  plan_mode: [PLAN_MODE, "F"],
  app_state: [APP_STATE, "F"],
  // 1.2.7 row 31 (F-4, CHAR-10, INTENT): Swarm's own API is never opened either.
  own_api: [OWN_API_TEXT, "F"],
}

/**
 * What the real `noWait` and the gate make of a D/P base on a tool call that is not the shell (spec section 3 rules 4-5):
 * `not_reversible` is redirected; any other runs as the main agent's, except a category the gate never believes opened
 * (row 51), which it refuses with that category's text. None waits.
 */
function noWaitWant(category: string): Want {
  const never = NEVER_OPENED[category]
  if (never) return answered(never[0], "X", category, never[1])
  if (category === "not_reversible") return answered(ARCHIVE_FIRST_TEXT, "X", "not_reversible", "Rd", "not_reversible")
  return {
    answer: "ran",
    line: { class: "A", category: "by_main_agent", bypassed: category, decision: "allow" },
    sections: ["M"],
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows 9 and 50-55: the gate's own paths
// ---------------------------------------------------------------------------------------------------------------------

describe("1.1.3 matrix rows 9, 50-55: gate paths", () => {
  it.instance("row 9 queue_full: never produced under consent; no slot is taken, no b0 marker (section 4)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      const { root } = yield* family(false)
      for (let index = 0; index < Permission.QUEUE_LIMIT; index++) {
        const input = yield* ask({ permission: "graft_find_code", patterns: [`q${index}`], metadata: {} }, root.id, test.directory)
        expect((yield* settle(input)) as unknown).toMatchObject({ waited: expect.stringContaining("DeferredError") })
      }
      const before = (yield* audit(root.id)).length
      const autonomy = yield* Autonomy.Service
      yield* autonomy.setMode({ scope: "session", root: root.id, on: true, bypassConsent: "bypass-v1", reportLanguage: "en" })
      const permission = yield* Permission.Service
      for (const call of [bash("node x.js"), bash("launchctl list"), { permission: "graft_find_code", patterns: ["q-new"], metadata: {} }]) {
        const input = yield* ask(call, root.id, test.directory)
        expect(yield* settle(input)).toEqual(RAN)
      }
      const after = (yield* audit(root.id)).slice(before)
      expect(after.filter((line) => line.type === "decision" && line.category === "queue_full")).toEqual([])
      expect(after.filter((line) => line.type === "marker" && line.marker === "b0")).toEqual([])
      expect((yield* permission.list()).length).toBe(Permission.QUEUE_LIMIT)
      // a base verdict of queue_full through the real noWait runs as the main agent's
      yield* check("row 9 base", { permission: "graft_find_code", patterns: ["qf"], metadata: {} }, noWaitWant("queue_full"), {
        wrap: viaNoWait({ class: "D", decidedBy: "gate", category: "queue_full" }),
      })
    }),
  )

  it.instance("row 50 the classifier throws (676), or names a consent the gate did not pass (682): UNJUDGED_TEXT, X not_routine / F", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      for (const caller of ["root", "subagent"] as const) {
        yield* check(`row 50 throws (${caller})`, { permission: "graft_find_code", patterns: ["t"], metadata: {} }, answered(UNJUDGED_TEXT, "X", "not_routine", "F"), { caller, wrap: throwing })
        yield* check(
          `row 50 unknown consent (${caller})`,
          { permission: "read", patterns: [".env"], metadata: { filepath: ".env" } },
          answered(UNJUDGED_TEXT, "X", "not_routine", "F"),
          { caller, wrap: forge({ class: "A", decidedBy: "gate", category: "consented", consentID: "never-passed" }) },
        )
      }
      expect(stub.calls).toEqual([])
    }),
  )

  it.instance("row 51 a forged opening of a NEVER_OPENED_X category: refused with that category's text (Rd for an archive redirect, else F)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      for (const [category, [text, section]] of Object.entries(NEVER_OPENED))
        for (const caller of ["root", "subagent"] as const)
          yield* check(`row 51 ${category} (${caller})`, { permission: "graft_find_code", patterns: [category], metadata: {} }, answered(text, "X", category, section), {
            caller,
            wrap: forge({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: category }),
          })
      expect(stub.calls).toEqual([])
    }),
  )

  it.instance("row 52 the decision line is not written on an allow (981-992): UNJUDGED_TEXT at once, nothing held, no line", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      for (const caller of ["root", "subagent"] as const) {
        const { root, child } = yield* family()
        const input = yield* ask(bash("node x.js"), caller === "root" ? root.id : child.id, test.directory)
        chmodSync(folder, 0o500)
        const outcome = yield* settle(input)
        chmodSync(folder, 0o755)
        expect({ caller, outcome }).toEqual({ caller, outcome: { text: UNJUDGED_TEXT } })
        expect((yield* audit(root.id)).filter((line) => line.type === "decision" && line.requestID === input.id)).toEqual([])
        expect((yield* pending).length).toBe(0)
      }
    }),
  )

  it.instance("row 53 any other defer or ask (the belt): UNJUDGED_TEXT, X not_routine with the category it would have waited on / F", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      for (const caller of ["root", "subagent"] as const) {
        for (const category of ["outward", "system_service", "queue_full", "decider_unavailable", "not_routine"])
          yield* check(`row 53 D ${category} (${caller})`, { permission: "graft_find_code", patterns: [category], metadata: {} }, answered(UNJUDGED_TEXT, "X", "not_routine", "F", category), {
            caller,
            wrap: forge({ class: "D", decidedBy: "gate", category }),
          })
        // `bypassed` keeps a held category only (index.ts belt: `isHeldCategory`); "script" is an allowed one
        yield* check(`row 53 P (${caller})`, { permission: "graft_find_code", patterns: ["p"], metadata: {} }, answered(UNJUDGED_TEXT, "X", "not_routine", "F"), {
          caller,
          wrap: forge({ class: "P", decidedBy: "agent", category: "script" }),
        })
        yield* check(`row 53 B no stop (${caller})`, { permission: "graft_find_code", patterns: ["b"], metadata: {} }, answered(UNJUDGED_TEXT, "X", "not_routine", "F"), {
          caller,
          wrap: forge({ class: "B", decidedBy: "person" }),
        })
      }
      expect(stub.calls).toEqual([])
    }),
  )

  it.instance("row 54 the same call already held (1332): shortcut skipped; judged afresh by its own row", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      const { root } = yield* family(false)
      const call = { permission: "graft_find_code", patterns: ["*"], metadata: {} }
      const first = yield* ask(call, root.id, test.directory)
      expect(yield* settle(first)).toEqual({ waited: "DeferredError external_tool" })
      const autonomy = yield* Autonomy.Service
      yield* autonomy.setMode({ scope: "session", root: root.id, on: true, bypassConsent: "bypass-v1", reportLanguage: "en" })
      const again = yield* ask(call, root.id, test.directory)
      expect(yield* settle(again)).toEqual(RAN)
      const line = (yield* audit(root.id)).find((item) => item.type === "decision" && item.requestID === again.id)
      expect(line && line.type === "decision" && { class: line.class, category: line.category, bypassed: line.bypassed, decision: line.decision, via: line.via }).toEqual({
        class: "A",
        category: "by_main_agent",
        bypassed: "external_tool",
        decision: "allow",
        via: "main_agent",
      })
    }),
  )

  it.instance("row 55 class B spend_limit and doom_loop: a stop (unchanged, not a wait), its text / I", () =>
    Effect.gen(function* () {
      for (const caller of ["subagent", "root"] as const) {
        yield* check(`row 55 doom_loop (${caller})`, { permission: "doom_loop", patterns: ["bash"], metadata: {} }, {
          answer: subagentStoppedMessage("bash"),
          line: { class: "B", decision: "reject" },
          sections: ["I"],
        }, { caller })
        yield* check(`row 55 spend_limit (${caller})`, { permission: "spend_limit", patterns: ["*"], metadata: {} }, {
          answer: SPEND_STOPPED_TEXT,
          line: { class: "B", decision: "reject" },
          sections: ["I"],
        }, { caller })
      }
      expect(stub.calls).toEqual([])
    }),
  )
})
