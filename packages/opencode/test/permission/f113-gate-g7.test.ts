// Swarm 1.1.3 decision T9, through the real gate (`Permission.ask`, src/permission/index.ts), for the root and for a
// subagent, with the end-report section each decision line lands in. Harness copied from f113-matrix.test.ts (row 8).
// - G7: a verdict that opens a script the screen flagged for sudo or for deleting is forged: under consent it is refused
//   at once (admin_rights / delete_compound), never run, never held. A soft flag (network) is still believed.
// - G1, G3, G5 end to end: the agent gets ARCHIVE_FIRST_TEXT or IRREVERSIBLE_ARCHIVE_TEXT, and the line is "Redirected".
// - Without consent the gate path is as 1.1.2: such a forged opening waits for a person.
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
  SPEND_STOPPED_TEXT,
  UNJUDGED_TEXT,
  mainAgentDeclined,
  subagentStoppedMessage,
} from "../../src/permission/autonomy-texts"
import { ScriptReader } from "../../src/permission/script-reader"
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

/** `RefusedByModeError` (index.ts, spec rows 12-13): copied here on purpose, so a change of the text fails this test. */
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

const SCREEN = (flag: "sudo" | "delete" | "network") => ({ bytes: 10, lines: 1, sha256: "0".repeat(64), flags: [flag] })
const OPENED_SCRIPT = (flag: "sudo" | "delete" | "network") => ({
  class: "A",
  decidedBy: "agent",
  category: "by_main_agent",
  bypassed: "script_flagged",
  screen: SCREEN(flag),
})

describe("T9 G7: the gate refuses a forged opening of a sudo- or delete-flagged script", () => {
  it.instance("a script flagged sudo: X admin_rights with the consent suffix, root and subagent / F", () =>
    refusedBoth(
      "G7 sudo",
      bash("node scripts/x.js"),
      answered(ADMIN_CONSENTED, "X", "admin_rights", "F", "script_flagged"),
      forge(OPENED_SCRIPT("sudo")),
    ),
  )
  it.instance("a script flagged delete: X delete_compound, DELETE_COMPOUND_TEXT, root and subagent / Rd", () =>
    refusedBoth(
      "G7 delete",
      bash("node scripts/x.js"),
      answered(DELETE_COMPOUND_TEXT, "X", "delete_compound", "Rd", "script_flagged"),
      forge(OPENED_SCRIPT("delete")),
    ),
  )
  it.instance("negative: a script flagged only for the network is believed and runs / M", () =>
    both("G7 network", bash("node scripts/x.js"), runs("script_flagged"), forge(OPENED_SCRIPT("network"))),
  )
  it.instance("without consent a forged sudo-flagged opening waits for a person, as in 1.1.2", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      populate(test.directory)
      const { root } = yield* family(false)
      const input = yield* ask(bash("node scripts/x.js"), root.id, test.directory)
      const outcome = yield* settle(input, forge(OPENED_SCRIPT("sudo")))
      expect("waited" in outcome).toBe(true)
      expect(stub.calls).toEqual([])
    }),
  )
})

describe("T9 G1, G3, G5 through the gate", () => {
  it.instance("G1 a deletion inside bash -c: ARCHIVE_FIRST_TEXT / Rd", () =>
    refusedBoth("G1 bash -c", bash(`bash -c "rm -rf src"`), answered(ARCHIVE_FIRST_TEXT, "X", "not_reversible", "Rd", "unreadable_command")),
  )
  it.instance("G1 an irreversible git command inside sh -c: IRREVERSIBLE_ARCHIVE_TEXT / Rd", () =>
    refusedBoth("G1 sh -c", bash(`sh -c "git reset --hard"`), answered(IRREVERSIBLE_ARCHIVE_TEXT, "X", "irreversible", "Rd")),
  )
  it.instance("G3 a cluster namespace delete: IRREVERSIBLE_ARCHIVE_TEXT / Rd", () =>
    refusedBoth("G3 kubectl", bash("kubectl delete ns prod"), answered(IRREVERSIBLE_ARCHIVE_TEXT, "X", "irreversible", "Rd", "outward")),
  )
  it.instance("G5 the whole crontab removed: ARCHIVE_FIRST_TEXT / Rd", () =>
    refusedBoth("G5 crontab", bash("crontab -r"), answered(ARCHIVE_FIRST_TEXT, "X", "not_reversible", "Rd", "system_service")),
  )
  it.instance("negative G1: a harmless bash -c runs / M", () => both("G1 echo", bash(`bash -c "echo hi"`), runs("unreadable_command")))
})
