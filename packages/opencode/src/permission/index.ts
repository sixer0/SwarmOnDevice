import { needsPerson } from "@opencode-ai/core/permission/needs-person"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Duration, Effect, Layer, Context, Option, Schema } from "effect"
import os from "os"
import path from "path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AGENT_BASELINE, PERMISSION_BASELINE } from "@opencode-ai/core/swarm-permission-baseline"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { Autonomy } from "./autonomy"
import { AutonomyDecider } from "./autonomy-decider"
import { AutonomyTable } from "./autonomy-table"
import { OutwardKnown } from "./outward-known"
import { ScriptScreen } from "./script-screen"
import { Unattended } from "./unattended"
import { Reach } from "../tool/reach"
import { Risk } from "../tool/risk"
import {
  MAIN_AGENT_UNAVAILABLE_TEXT,
  REFUSED_TEXT,
  SPEND_STOPPED_TEXT,
  UNJUDGED_TEXT,
  consentedRefusalText,
  mainAgentDeclined,
  subagentStoppedMessage,
} from "./autonomy-texts"
import { ProcessTree } from "./process-tree"
import { ScriptReader } from "./script-reader"
import { BypassScreen } from "./bypass-screen"
import { ProjectTrust } from "@opencode-ai/core/project/trust"

/** 1.1.1 F12a (P4, m29): how long a consented request waits for the script reader before it is judged without it. */
export const SCRIPT_READER_WAIT = "2 seconds"
/** 1.1.1 F14 (G5-P4): the same bound in ms, counted from when the reader's start began (one deadline for all requests). */
export const SCRIPT_READER_WAIT_MS = 2_000

export const Event = PermissionV1.Event

export const MAX_SKIPPED = 20

/** Held calls one root may have open. The next one is told so and stays out, because nothing here is ever dropped. */
export const QUEUE_LIMIT = 20

/** One call an entry held by autonomous mode stands for. Several calls of one family with one permission and pattern share it. */
export interface HeldCall {
  readonly requestID: PermissionV1.ID
  readonly sessionID: SessionID
  /** The exact call, as `ask` wrote it down. A grant is good for this and no other. */
  readonly call: string
  readonly follows?: PermissionV1.Follows
}

/**
 * The request an answer settled, with what that one answer also covers. Not public: `follows` never leaves the server.
 * `calls` is the whole list the person approved, at the version they saw; `call` is its first. Whoever acts on the answer
 * grants each of them, since nothing here does.
 */
export type Answered = PermissionV1.Request & {
  follows?: PermissionV1.Follows
  call?: string
  calls?: ReadonlyArray<HeldCall>
  /** Other entries of the family an "always in this session" covered, closed as approved with it (row 258). */
  released?: ReadonlyArray<Answered>
}

export interface Grant extends Pick<PermissionV1.Request, "sessionID" | "permission" | "patterns"> {
  /** Came along with another request's answer, on the entry that showed this call. A refusal still holds for it. */
  followed?: boolean
  /** The exact call this answer was about. Without it, it is an answer from outside autonomous mode and means nothing inside. */
  call?: string
  /**
   * An approval of an entry back from a restart, which no longer knows its call (F1). It lets the agent's repeat through:
   * the same permission and patterns, from the session that asked, in the run of the mode it was given in. "once" is used
   * up by that one prompt.
   *
   * "session" is a person's "always in this session" on a held entry (row 258). `patterns` are that request's own "always"
   * patterns. It lets through what the mode would hold of the same permission within them, in the family, for the run of
   * the mode it was given in. Memory only: a restart ends it.
   *
   * "same" is a person's plain yes on a held entry (row 278): the very call they approved, to the letter (`call`: the tool,
   * the command and its folder), is let through again whenever the mode would hold it, in the family, for the run of the
   * mode it was given in, so an agent that repeats a command does not block on it twice. What the mode refuses is still
   * refused. Memory only: a restart ends it.
   */
  uses?: "once" | "session" | "same"
  /** A "session" grant from a plain yes (row 278): it covers only what is held for a repeatable reason. */
  repeatOnly?: boolean
}

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  /** Returns the request when the agent had already carried on without it: the caller decides how to pick that back up. */
  readonly reply: (
    // `abandoned`: nobody will answer this any more, because its session is gone or archived. Not on the public input.
    // `version`: the `metadata.version` of the entry the person looked at. An approval is good for that list only.
    input: PermissionV1.ReplyInput & { abandoned?: boolean; version?: number },
  ) => Effect.Effect<Answered | undefined, PermissionV1.NotFoundError>
  /** Lets one later call through without asking, for what the user allowed after the agent had carried on. */
  readonly grant: (input: Grant) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  /**
   * After a person ticks consent items of a root's list: closes what the tick answered and returns it, as `reply` does,
   * for the caller to run (C98). Optional only so stand-ins elsewhere need not change; the real service always has it.
   */
  readonly consentTicked?: (root: SessionID) => Effect.Effect<ReadonlyArray<Answered>>
}

interface PendingEntry {
  info: PermissionV1.Request
  noAlways?: boolean
  follows?: PermissionV1.Follows
  /** Set when autonomous mode held this, which is also what the agent gets told while it stays held. */
  category?: PermissionV1.DeferredCategory
  /** Whose queue this counts against, set only on what autonomous mode held. A child's deleted session cannot lose it. */
  root?: SessionID
  /**
   * The exact calls a person is shown, on what autonomous mode held, oldest first. The list only grows, so its length is
   * its version. Gone after a restart, along with what was shown.
   */
  calls?: HeldCall[]
  /**
   * How many consent items the person had allowed when the mode held this, or last added a call to it. A tick since is
   * an answer the entry never saw, so a repeat goes to the gate again instead of joining (C98).
   */
  given?: number
  /**
   * The list's version when it is not its length: a consent tick that let some calls through leaves the rest under a new
   * version, so a click on the list as it was is no answer (C98).
   */
  version?: number
  /** What each call on the list asked, by its `call`, for the table to look at again when a consent item is ticked. */
  asks?: ReadonlyMap<string, { input: PermissionV1.AskInput; userCatchAll: boolean }>
  /**
   * The "always" patterns of the call the mode held, which the shown request leaves out: what "always in this session"
   * covers (row 258). None when the call offers no "always", or after a restart.
   */
  always?: ReadonlyArray<string>
  /** Asked with autonomous mode off for its root: only such an entry is released by a session's exact "always" (1.1.4). */
  offMode?: true
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  /** 1.1.4 (U2): a person's "always in this session" outside autonomous mode, by root session. Memory only. */
  sessionRules: Map<SessionID, PermissionV1.Rule[]>
  /**
   * The same, on a prompt that offered no "always": the very prompt, matched by string equality (never a glob), with the
   * command folder when it has one. Acts only while autonomous mode is off for the root.
   */
  sessionExact: Map<SessionID, SessionExact[]>
  /** Each with the root of the session it was given to: an answer at the root is good for its subagents too. */
  grants: (Grant & { root: SessionID; since?: number })[]
  /**
   * Session families (by root) where a request went unanswered and none was answered since: nobody is there, so a new
   * ask of the family is queued at once instead of waiting again (P-03). A reply to any request of the family clears it.
   */
  away: Set<SessionID>
  /** Roots already reported as full. One report for each time it fills up, however many calls find it so. */
  full: Set<SessionID>
}

const samePrompt = (
  a: Pick<PermissionV1.Request, "permission" | "patterns">,
  b: Pick<PermissionV1.Request, "permission" | "patterns">,
) =>
  a.permission === b.permission &&
  a.patterns.length === b.patterns.length &&
  a.patterns.every((pattern, index) => pattern === b.patterns[index])

interface SessionExact {
  permission: string
  patterns: string[]
  workdir?: string
}

const workdirOf = (request: Pick<PermissionV1.Request, "metadata">) =>
  typeof request.metadata?.workdir === "string" ? request.metadata.workdir : undefined

/** Whether a session's exact "always" is this prompt: same permission, same patterns in order, same command folder. */
const exactCovers = (
  rules: ReadonlyArray<SessionExact> | undefined,
  request: Pick<PermissionV1.Request, "permission" | "patterns" | "metadata">,
) => {
  if (!rules || rules.length === 0) return false
  const workdir = workdirOf(request)
  return rules.some((rule) => samePrompt(rule, request) && rule.workdir === workdir)
}

/** What the line of a call let through by a person's "always in this session" says, for Activity to show (row 258). */
const SESSION_REASON = 'a person\'s "always in this session"'

/**
 * Row 278: what a plain yes is good for again. Only holds about a call not being routine yet; a send or push, anything
 * nothing can undo, a secret, a sensitive file and a person's own "ask every time" are asked about each time.
 */
const REPEATABLE: ReadonlySet<string> = new Set(["not_routine", "outside_folder", "no_undo", "folder_not_trusted", "program_not_trusted", "external_tool"])

/** Whether a call is one a yes is good for again: a repeatable hold, and no command in it the shell's own scan calls risky. */
const repeatable = (entry: { category?: string; info: PermissionV1.Request }) => {
  if (!REPEATABLE.has(entry.category ?? "")) return false
  if (typeof entry.info.metadata.risk === "string") return false
  const command = entry.info.metadata.command
  if (typeof command !== "string") return true
  return !command
    .split(/&&|\|\||[;|\n]/)
    .some((piece) => Risk.classify(piece.trim().split(/\s+/).filter(Boolean)).kind === "risky")
}

/** Whether a "session" grant covers this prompt: its permission, and every pattern within the "always" it named. */
const withinSession = (
  grant: Pick<Grant, "permission" | "patterns">,
  request: Pick<PermissionV1.Request, "permission" | "patterns">,
) =>
  grant.permission === request.permission &&
  request.patterns.every((pattern) => grant.patterns.some((always) => Wildcard.match(pattern, always)))

const sameRequest = (
  a: Pick<PermissionV1.Request, "sessionID" | "permission" | "patterns">,
  b: Pick<PermissionV1.Request, "sessionID" | "permission" | "patterns">,
) => a.sessionID === b.sessionID && samePrompt(a, b)

/** What an entry shows of each call it stands for. A call that could not be written down shows as its request id. */
const shownCalls = (calls: ReadonlyArray<HeldCall>) =>
  calls.map((held) => (held.call === held.requestID ? held.call : (JSON.parse(held.call) as unknown)))

// Which rules are the shipped catch-all. Kept beside the rules rather than on them: the rule shape is public API, and an
// object that was never marked, such as a session's own rule, counts as the person's.
const shippedCatchAll = new WeakSet<PermissionV1.Rule>()

/** Set by config on a permission block when a source other than the shipped baseline wrote its `"*"`. */
export const USER_CATCH_ALL = Symbol.for("swarm.permission.userCatchAll")

export const isShippedCatchAll = (rule: PermissionV1.Rule) => shippedCatchAll.has(rule)

// E2 (C100): which allow and deny rules Swarm ships, so the line an exit through one leaves in the mode credits the
// built-in rule and not the person. Kept beside the rules, as the catch-all is; an object never marked counts as the person's.
const shippedRules = new WeakSet<PermissionV1.Rule>()

export const isShipped = (rule: PermissionV1.Rule) => shippedRules.has(rule)

// The baseline is merged into the person's config, so its rules are known by their value. A person who writes the same
// value as the baseline gets the same decision, and its line credits the built-in rule.
const SHIPPED_BLOCKS: ReadonlyArray<Readonly<Record<string, string | Readonly<Record<string, string>>>>> = [
  PERMISSION_BASELINE,
  ...Object.values(AGENT_BASELINE).map((agent) => agent.permission),
]
const isBaselineRule = (key: string, pattern: string, action: string) =>
  SHIPPED_BLOCKS.some((block) => {
    const value = Object.hasOwn(block, key) ? block[key] : undefined
    if (typeof value === "string") return pattern === "*" && value === action
    return value !== undefined && Object.hasOwn(value, pattern) && value[pattern] === action
  })

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

/** One model's answer on one class P request. It settles that call only, and nothing it says can change a class. */
export interface Decided {
  readonly decision: "allow" | "reject" | "defer"
  readonly decidedBy: Extract<Autonomy.AuditEntry, { type: "decision" }>["decidedBy"]
  readonly reason?: string
  readonly memo?: boolean
  readonly latencyMs?: number
  readonly costUsd?: number
  /** Calls made to the model for this answer, retries after a timeout included. */
  readonly attempts?: number
}

/**
 * The decider's no. A denial to everything that reads one, so the agent goes on, in words that are true: nobody wrote a
 * rule. The reason is fixed on purpose. The model's own stays in the audit, since repository text can steer it.
 */
class DeciderRefusedError extends PermissionV1.DeniedError {
  override get message() {
    return "This call did not run. Autonomous mode refused it: an automatic check judged that it does not serve what the user asked for. Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list what was refused in your final message."
  }
}

/**
 * 1.1.1 (S1.37): the main agent said no to a subagent's call under the consented bypass, or could not be reached. The text
 * is the main agent's own reason (one printable line) or the fixed unavailable text: the subagent reads it and goes on.
 */
export class MainAgentRefusedError extends PermissionV1.DeniedError {
  text = ""
  override get message() {
    return this.text
  }
}

const mainAgentRefused = (text: string) => {
  const error = new MainAgentRefusedError({ ruleset: [] })
  error.text = text
  return error
}

/** 1.1.1 (S0.1): the reason on the line of a call the consented bypass let the main agent decide. */
export const BYPASS_REASON = "the person agreed that the main agent decides during this run"

/**
 * Defence in depth (S1.36): categories the overlay never opens. A verdict that claims to have opened one of them did not
 * come from `underConsent`, and runs nowhere near the main agent. The X ones are refused, the rest held for a person.
 */
const NEVER_OPENED_X: ReadonlySet<string> = new Set([
  "irreversible",
  "admin_rights",
  "delete_compound",
  "outside_write",
  "protected_path",
  "credential_change",
  "plan_mode",
  "app_state",
])
// 1.1.3: the KEPT_D categories, outward sends and soft script flags are opened by `noWait` under consent, so the gate
// believes them there; only the X categories above stay forged (spec section 3), and (T9 G7) a script flagged for sudo
// or for deleting, which `noWait` refuses as `admin_rights` or `delete_compound`.
const GATE_HARD_SCRIPT_FLAGS: ReadonlySet<string> = new Set(["sudo", "delete"])

/**
 * 1.1.3: the gate's belt answer under consent. Anything that would have waited (a defer, an ask, a record that failed, a
 * table that could not judge) is refused at once with `UNJUDGED_TEXT` (`REFUSED_TEXT.not_routine`).
 */
const UNJUDGED: AutonomyTable.Verdict = { class: "X", decidedBy: "gate", category: "not_routine" }

/** Class X. Nobody wrote a rule and nobody can answer this, so the text says neither. */
class RefusedByModeError extends PermissionV1.DeniedError {
  override get message() {
    return "This call did not run. Autonomous mode never allows this kind of call, whoever is asked. Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list what was refused in your final message."
  }
}

/**
 * Class X with its own register text (U11): the way on differs per category, so the text names it. The texts are
 * `autonomy-texts.ts`, which the shell reads as well, so the two cannot drift.
 */
class RefusedWithTextError extends RefusedByModeError {
  text = ""
  override get message() {
    return this.text
  }
}

/**
 * U11 rule 11: in the mode a spend limit or a repeating call waits for nobody. It ends the run, so it is a rejection.
 * The text starts with `SUBAGENT_STOPPED` (`autonomy-texts.ts`), by which `tool/task.ts` turns a subagent's run ended by
 * it into text for its parent.
 */
class StoppedByModeError extends PermissionV1.RejectedError {
  stopText = ""
  override get message() {
    return this.stopText
  }
}

const stoppedByMode = (input: PermissionV1.AskInput) => {
  const error = new StoppedByModeError()
  error.stopText =
    input.permission === "doom_loop" ? subagentStoppedMessage(input.patterns[0] ?? "a tool") : SPEND_STOPPED_TEXT
  return error
}

/**
 * 1.1.3 (T6): the class X answer while the person's consent to the bypass applies. Same error classes as 1.1.0; the text is
 * `consentedRefusalText`, which adds the continue suffix to credential_change and admin_rights.
 */
export const refusedUnderConsent = (category: string | undefined) => {
  const text = consentedRefusalText(category)
  if (text === undefined) return new RefusedByModeError({ ruleset: [] })
  const error = new RefusedWithTextError({ ruleset: [] })
  error.text = text
  return error
}

export const refusedByMode = (category: string | undefined) => {
  const text =
    category !== undefined && Object.hasOwn(REFUSED_TEXT, category)
      ? REFUSED_TEXT[category as keyof typeof REFUSED_TEXT]
      : undefined
  if (text === undefined) return new RefusedByModeError({ ruleset: [] })
  const error = new RefusedWithTextError({ ruleset: [] })
  error.text = text
  return error
}

/** Settles class P. A seam, so a test can count what reaches it. */
export class Decider extends Context.Service<
  Decider,
  {
    readonly decide: (
      input: PermissionV1.AskInput,
      root: SessionID,
      category?: string,
      // The screen's closed summary of the script a command runs (U11 rule 6), never the script itself.
      script?: ScriptScreen.Summary,
      // 1.1.1 (S1.34): set when the main agent decides for a subagent under the consented bypass.
      options?: AutonomyDecider.Options,
    ) => Effect.Effect<Decided>
  }
>()("@opencode/PermissionDecider") {}

const UNDECIDED: Decided = { decision: "defer", decidedBy: "system:decider_unavailable" }
/** S1.33: the main agent could not decide for a subagent. Refused, never held. */
const MAIN_AGENT_FAILED: Decided = {
  decision: "reject",
  decidedBy: "system:main_agent_unavailable",
  reason: "model_error",
}

const held = (category: AutonomyTable.HeldCategory): AutonomyTable.Verdict => ({
  class: "D",
  decidedBy: "gate",
  category,
})

const isHeldCategory = Schema.is(PermissionV1.DeferredCategory)
const decodeRequest = Schema.decodeUnknownOption(PermissionV1.Request)

/** What a person allowed of this root's consent list (U11 rule 2), as the gate hands it to the table. */
export interface Consented {
  /** The list's id. */
  readonly id: string
  /** Each concrete path a person allowed, with the id of the item that covers it. A pattern on its own covers nothing. */
  readonly files: ReadonlyMap<string, string>
}

/**
 * What the gate adds to the table's input for U11 rule 2 (row 124, contract for row 110). Absent means no list: no mission
 * yet, the mode off, or a restart, after which every item is held again. Rule 3 has its own field, `outward` (row 108).
 */
export interface GateContext {
  readonly consent?: Consented
}

/**
 * What rows 110 and 112 may add to a verdict, beside what row 108 did. `consentID` is the item a class A answer used, and
 * must be one the gate passed. `screen` is the script screen behind a `script` or `script_flagged` answer, of which the
 * decider only ever gets the closed summary (C70). Read as optional, so the gate holds before those rows land.
 */
export type Answer = AutonomyTable.Verdict & {
  readonly screen?: {
    readonly bytes: number
    readonly lines: number
    readonly sha256: string
    readonly flags: readonly ScriptScreen.Flag[]
  }
}

/** The table, as a seam a test can replace to see what reaches it. Nothing else provides it. */
export const Classify = Context.Reference<(input: AutonomyTable.Input & GateContext) => Answer>(
  "~opencode/PermissionClassify",
  {
    defaultValue: () => AutonomyTable.classify,
  },
)

/** The allowed items of a root's list, by concrete path. */
export function consented(consent: Autonomy.Consent | undefined): Consented | undefined {
  if (!consent) return undefined
  const given = consent.items.filter((item) => consent.given.has(item.id))
  return { id: consent.id, files: new Map(given.flatMap((item) => item.files.map((file) => [file, item.id] as const))) }
}

/**
 * `ProcessTree.ofSession`, as a seam: the processes this session's shell tool started and everything below them. A test
 * names its own processes. Nothing else provides it.
 */
export const OwnProcesses = Context.Reference<(session: SessionID) => Promise<ReadonlySet<number>>>(
  "~opencode/PermissionOwnProcesses",
  {
    defaultValue: () => (session) => ProcessTree.ofSession(session),
  },
)

/** `OutwardKnown.recheck`, as a seam: a test has no `gh` login to check against. Nothing else provides it. */
export const Recheck = Context.Reference<typeof OutwardKnown.recheck>("~opencode/PermissionRecheck", {
  defaultValue: () => OutwardKnown.recheck,
})

/**
 * What the table needs for U11 rule 3 (row 108): the destinations a person named and ticked, the snapshot they were matched
 * in, and for a push the recheck run just now. A recheck that fails to run is no recheck, which the table holds.
 */
export async function outwardOf(
  input: Pick<PermissionV1.AskInput, "metadata">,
  cwd: string,
  consent: Autonomy.Consent | undefined,
  recheck: typeof OutwardKnown.recheck = OutwardKnown.recheck,
  // 1.1.1 F29 (P44): the hosts the person's messages of the mission window name now (`Autonomy.missionHosts`), and the
  // project, so a push inside a project script the call runs by name is rechecked too.
  more: { readonly hosts?: readonly OutwardKnown.Destination[]; readonly instance?: AutonomyTable.Input["instance"] } = {},
): Promise<AutonomyTable.Outward | undefined> {
  if (!consent) return undefined
  const allowed = Autonomy.consentedDestinations(consent)
  const snapshot = consent.snapshot
  // 1.1.1 F26 (P42): every destination the mission named, ticked or not, for the consented bypass only. 1.1.1 F29 (P44,
  // D-F26-3 reversed): and every host the person's messages name at this call, those after the scan included.
  // 1.1.1 F30 (P46, CR12-3): when the person's messages are read at this call, their hosts are taken from that reading
  // only (URLs, and bare names that are no file name), never from the scan's own list of hosts, which read the same
  // messages without that rule. Ticked items count as before (`allowed`).
  const scanned = [...consent.destinations.values()]
  const named = more.hosts ? [...scanned.filter((item) => item.kind !== "host"), ...more.hosts] : scanned
  // The 1.1.0 target first; only when it names none, the consented bypass's (a push with no remote named, or a step of a
  // compound call). The 1.1.0 table holds any push whose own target differs from the recheck's, so this loosens nothing.
  // 1.1.1 F30 (G12-P3): in a classify scope of its own, so the scripts it expands are read once.
  const push =
    snapshot &&
    Reach.snapshotScope(
      () =>
        AutonomyTable.pushTarget({ metadata: input.metadata, cwd }, snapshot) ??
        AutonomyTable.consentPushTarget({ metadata: input.metadata, cwd }, snapshot, more.instance),
    )
  if (!snapshot || !push) return { allowed, snapshot, named }
  const result = await recheck(snapshot, push.repo, push.remote).catch(() => undefined)
  return result ? { allowed, snapshot, named, recheck: { ...push, result } } : { allowed, snapshot, named }
}

/**
 * How a class A answer came to be, for its line: a person's consent item or a ticked destination. A `consentID` the gate
 * did not pass is not believed, and the call is held.
 */
export function usedConsent(
  verdict: Answer,
  context: GateContext & { outward?: AutonomyTable.Outward },
): "consent" | "outward" | "unknown" | undefined {
  if (verdict.consentID === undefined || verdict.class !== "A") return undefined
  if (verdict.via === "outward")
    return context.outward?.allowed.some((item) => item.id === verdict.consentID) ? "outward" : "unknown"
  return context.consent && [...context.consent.files.values()].includes(verdict.consentID) ? "consent" : "unknown"
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const decider = yield* Decider
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          sessionRules: new Map(),
          sessionExact: new Map(),
          grants: [],
          away: new Set(),
          full: new Set(),
        } satisfies State as State
        yield* restore(ctx.directory, state.pending)

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const rootOf = (
      sessionID: SessionID,
    ): Effect.Effect<{ id: SessionID; directory?: string; time?: { archived?: number } }> =>
      sessions.get(sessionID).pipe(
        Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session))),
        Effect.catchCause(() => Effect.succeed({ id: sessionID })),
      )

    const close = (
      entry: PendingEntry,
      outcome: "approved_later" | "rejected_later" | "abandoned",
      by: "person" | "system:session_closed",
    ) =>
      Effect.gen(function* () {
        if (!entry.root) return
        yield* autonomy
          .record(entry.root, { type: "outcome", requestID: entry.info.id, outcome, by })
          // Logged by record. Without this line the entry is asked about again after a restart, and nothing runs by it.
          .pipe(Effect.ignore)
        const { full } = yield* InstanceState.get(state)
        full.delete(entry.root)
      })

    /**
     * Brings back what was held before the last restart, as questions only: the file can make one appear, never answer
     * one. So `follows` stays out even though the line has a place for it, and the agent asks again for the rest.
     */
    const restore = Effect.fnUntraced(function* (directory: string, pending: State["pending"]) {
      const counted = new Map<string, number>()
      for (const line of yield* autonomy.openDecisions()) {
        // A duplicate points at the entry it repeated and was never an entry itself.
        if (line.via === "duplicate") continue
        const sessionID = line.sessionID as SessionID
        const session = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        const root = yield* rootOf(sessionID)
        if (!session || root.id !== line.rootID) {
          yield* Effect.logWarning("left out a held call whose session is not there", { requestID: line.requestID })
          continue
        }
        if (root.directory !== directory) continue
        if (session.time.archived || root.time?.archived) {
          yield* autonomy
            .record(root.id, {
              type: "outcome",
              requestID: line.requestID,
              outcome: "abandoned",
              by: "system:session_closed",
            })
            .pipe(Effect.ignore)
          continue
        }
        const taken = counted.get(root.id) ?? 0
        const info = decodeRequest({
          id: line.requestID,
          sessionID: line.sessionID,
          permission: line.permission,
          patterns: line.patterns,
          metadata: {},
          always: [],
          tool: line.messageID && line.callID ? { messageID: line.messageID, callID: line.callID } : undefined,
          movedOnAt: line.at,
          deferred: true,
        })
        // More than the gate ever lets in means lines nobody here wrote. The oldest are the ones it did.
        if (taken >= QUEUE_LIMIT || info._tag === "None") {
          yield* Effect.logWarning("left out a held call", { requestID: line.requestID, root: root.id })
          continue
        }
        counted.set(root.id, taken + 1)
        pending.set(info.value.id, {
          info: info.value,
          category: isHeldCategory(line.category) ? line.category : "not_routine",
          root: root.id,
          // Nothing is waiting on this: the run it stopped is over.
          deferred: yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>(),
        })
      }
    })

    /** What the table makes of a call now, with what a person allowed of the root's consent list. No line, no decider. */
    // `bypass` (S1.30): set only while the person's consent to the bypass applies to this root and nothing changed the state
    // files from outside. Absent, the table answers exactly as in 1.1.0.
    const judge = Effect.fnUntraced(function* (
      input: PermissionV1.AskInput,
      userCatchAll: boolean,
      root: SessionID,
      bypass?: { readonly caller: "root" | "subagent" },
    ) {
      const instance = yield* InstanceState.context
      // Undefined when it could not be read, and a lineage nobody can place is held to the plan agent's limits.
      const last = yield* sessions
        .findMessage(root, (message) => message.info.role === "user")
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.map((message) => ({ agent: message?.info.role === "user" ? message.info.agent : undefined })),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      const folder = yield* autonomy
        .folderState(instance.directory)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const workdir = input.metadata.workdir
      const cwd = typeof workdir === "string" && path.isAbsolute(workdir) ? workdir : undefined
      const canUndo = input.canUndo ?? false
      // U11 rules 2 and 3: what the person allowed of this root's list, and where this call would send something. Memory
      // only, so after a restart there is no list and everything on it is held again.
      const consent = yield* autonomy.consent(root).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const recheck = yield* Recheck
      // 1.1.1 F29 (P44): the mission's hosts are read once per call, so every step of it is judged on the same list.
      // 1.1.1 F30 (G12-P1): only for a call that can send (a shell call or a fetch); the read itself is incremental.
      const sends = input.permission === "bash" || input.permission === "webfetch" || input.permission === "external_directory"
      const hosts = consent && sends && autonomy.missionHosts ? yield* autonomy.missionHosts(root) : []
      const outward = yield* Effect.promise(() =>
        outwardOf(input, cwd ?? instance.directory, consent, recheck, { hosts, instance }),
      )
      const context = { consent: consented(consent), outward }
      // S1.31: only a command that may kill something needs to know which processes are Swarm's. A failure is none.
      const command = input.metadata.command
      const own = yield* OwnProcesses
      const ownProcesses =
        bypass && input.permission === "bash" && typeof command === "string" && BypassScreen.namesKill({ metadata: input.metadata, cwd: cwd ?? instance.directory })
          ? yield* Effect.promise(() =>
              Promise.resolve(input.sessionID)
                .then(own)
                .catch(() => new Set<number>() as ReadonlySet<number>),
            )
          : undefined
      const classify = yield* Classify
      const tableInput: AutonomyTable.Input & GateContext = {
        permission: input.permission,
        patterns: input.patterns,
        metadata: input.metadata,
        instance,
        cwd: cwd ?? instance.directory,
        canUndo,
        folder,
        editClass: input.editClass,
        plan: input.agent === "plan" || last === undefined || last.agent === "plan",
        rule: userCatchAll ? "user_catch_all" : undefined,
        follows: input.follows,
        ...(bypass && { bypass }),
        ...(ownProcesses && { ownProcesses }),
        ...context,
      }
      const classified = yield* Effect.try({
        // `harmless` stays out: such a call only gets here when a rule naming its permission asked about it.
        try: () => classify(tableInput),
        catch: String,
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("could not classify a permission request", { permission: input.permission, error }).pipe(
            // 1.1.3: under consent nothing waits, so a call the table could not judge is refused at once.
            Effect.as(bypass ? UNJUDGED : held("not_routine")),
          ),
        ),
      )
      // A consent the gate did not pass is not believed (row 124): the call is held rather than let through on it.
      // 1.1.3: under consent it is refused at once instead.
      const used = usedConsent(classified, context)
      const table: Answer = used === "unknown" ? (bypass ? UNJUDGED : held("not_routine")) : classified
      const via = used === "consent" || used === "outward" ? used : undefined
      return { last, cwd, canUndo, table, via, tableInput }
    })

    /** What autonomous mode does with this request. Undefined when its root is not in the mode, and nothing changes then. */
    const gate = Effect.fn("Permission.gate")(function* (
      input: PermissionV1.AskInput,
      requestID: PermissionV1.ID,
      userCatchAll: boolean,
      // Takes a place in the root's queue, in one step with counting it. False when there is none left, and the id of the
      // entry it joined when one of the family already holds the same permission and patterns.
      hold: (root: SessionID, category: PermissionV1.DeferredCategory) => Effect.Effect<boolean | PermissionV1.ID>,
      // A grant from a person's answer covers it, so only a refusal is left to find, and a line that says the grant was used.
      followed = false,
      // Let through by an "always" a person gave earlier: theirs to give, so it runs, but it was given outside the mode.
      standing = false,
      // Within a person's "always in this session" (row 258): what the mode would hold for them runs instead. Only a hold:
      // a refusal, a stop, a decider's answer or anything the person is asked about directly stays as it is.
      // "same" (row 278): the very call a person said yes to before, which runs only where it is held as not yet routine.
      session: boolean | "same" = false,
    ) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(input.sessionID)
      const directory = root.directory ?? instance.directory
      yield* autonomy.markMode({ root: root.id, directory })
      const check = yield* autonomy.check({ root: root.id, directory })
      if (!check.on) return undefined
      // S1.30: the person's consent to the bypass, for this request. A change to the state files from outside turns it off
      // for the request (S1.39), and so does a consent that cannot be read: the table then answers as in 1.1.0.
      const consentNow =
        check.externalChange.length === 0
          ? yield* autonomy
              .bypassOf({ root: root.id, directory })
              .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      const bypass = consentNow
        ? ({ caller: root.id === input.sessionID ? "root" : "subagent" } as const)
        : undefined
      // The table reads project scripts synchronously; its shell reader starts asynchronously, so wait for it once.
      // 1.1.1 F12a (P4, m29): for at most `SCRIPT_READER_WAIT`; a reader still not ready leaves scripts at 1.1.0.
      // 1.1.1 F14 (G5-P4): the bound counts from when the start began, so a start that hangs is waited for once in all.
      if (bypass && !ScriptReader.isReady()) {
        const starting = ScriptReader.prepare()
        const left = ScriptReader.waitLeft(SCRIPT_READER_WAIT_MS)
        if (left > 0) yield* Effect.promise(() => starting).pipe(Effect.timeoutOption(Duration.millis(left)))
      }
      const { last, cwd, canUndo, table: judgedTable, via } = yield* judge(input, userCatchAll, root.id, bypass)
      // S1.36, defence in depth: only the consent overlay opens a call, only under consent, and never one of the X
      // categories. A verdict that says otherwise is not believed: what nothing may run is refused, the rest (1.1.0 path
      // only) waits for a person. 1.1.3: `noWait` opens the KEPT_D categories, outward sends and soft script flags, so under
      // consent only `NEVER_OPENED_X` is forged (spec section 3).
      const opened = judgedTable.class === "A" ? judgedTable.bypassed : undefined
      // 1.1.3 (T9 G7): a script the screen flagged for sudo or for deleting is never opened either; the table refuses it
      // (`noWait` rule 3), so an A that says otherwise is forged and gets that refusal.
      const hardFlag =
        opened === "script_flagged" ? judgedTable.screen?.flags.find((flag) => GATE_HARD_SCRIPT_FLAGS.has(flag)) : undefined
      const forged = opened !== undefined && (bypass === undefined || NEVER_OPENED_X.has(opened) || hardFlag !== undefined)
      if (forged)
        yield* Effect.logError("a verdict opened a call the bypass never opens", {
          requestID,
          permission: input.permission,
          bypassed: opened,
          consent: bypass !== undefined,
        })
      const table: Answer = !forged
        ? judgedTable
        : NEVER_OPENED_X.has(opened)
          ? { class: "X", decidedBy: "gate", category: opened as AutonomyTable.Verdict["category"] }
          : hardFlag !== undefined && bypass !== undefined
            ? { class: "X", decidedBy: "gate", category: hardFlag === "sudo" ? "admin_rights" : "delete_compound", bypassed: "script_flagged" }
            : held(isHeldCategory(opened) ? opened : "not_routine")
      // An "always" on what the mode lets anyway answers nothing: an ordinary edit is on record as the gate's, not a person's.
      const answered =
        (followed || standing) &&
        table.class !== "X" &&
        !(standing && !followed && table.class === "A" && input.editClass === "ordinary")
      // Relative paths in a command mean nothing until its real folder is known, so no decider sees it without one.
      const placed = table.class === "P" && input.permission === "bash" && !cwd ? held("not_routine") : table
      const checked: AutonomyTable.Verdict = answered
        ? { ...table, class: "A", decidedBy: "person" }
        : Autonomy.afterCheck(placed.class, check) === placed.class
          ? placed
          : held("not_routine")
      // 1.1.3, the belt: under consent no call waits and class P is the main agent's (the table's `noWait`), so the decider
      // is never asked for it. Whatever would still wait here (a D, a P, a B no stop covers) is refused at once, and its
      // line keeps the category it would have waited on.
      const belted =
        bypass !== undefined &&
        (checked.class === "D" || checked.class === "P" || (checked.class === "B" && !needsPerson(input.permission)))
      if (belted)
        yield* Effect.logError("a consented call would have waited", {
          requestID,
          permission: input.permission,
          class: checked.class,
          category: checked.category,
        })
      const verdict: AutonomyTable.Verdict = belted
        ? { ...UNJUDGED, ...(isHeldCategory(checked.category) && { bypassed: checked.category }) }
        : checked
      // The decider gets the screen's closed summary, never the script (C70, ADV-P2). Only what the table answered on.
      const screen = verdict === table ? table.screen : undefined
      const screened = screen && ScriptScreen.summary(screen)
      // S1.32/S1.33: a call the consented bypass opened. The main agent's own call runs on the person's consent; a
      // subagent's goes to the main agent, which answers yes or no and never holds it.
      const overlaid = !answered && bypass !== undefined && verdict.class === "A" && verdict.bypassed !== undefined
      const forSubagent = overlaid && bypass.caller === "subagent"
      const mainAgent = `agent:main/${last?.agent ?? "build"}` as const
      const asked =
        verdict.class === "P"
          ? yield* decider.decide(input, root.id, verdict.category, screened).pipe(
              // Cut off, by a reload or a cancelled run: nothing was decided, and nothing is waiting for anyone.
              Effect.onInterrupt(() =>
                autonomy
                  .record(root.id, {
                    type: "outcome",
                    requestID,
                    outcome: "not_run",
                    by: "system:decider_interrupted",
                  })
                  // Logged by record, and the call does not run either way.
                  .pipe(Effect.ignore),
              ),
              Effect.catchCause(() => Effect.succeed(UNDECIDED)),
            )
          : forSubagent
            ? yield* decider
                .decide(input, root.id, verdict.bypassed, screened, { forSubagent: { agent: last?.agent ?? "build" } })
                .pipe(
                  Effect.onInterrupt(() =>
                    autonomy
                      .record(root.id, {
                        type: "outcome",
                        requestID,
                        outcome: "not_run",
                        by: "system:decider_interrupted",
                      })
                      // Logged by record, and the call does not run either way.
                      .pipe(Effect.ignore),
                  ),
                  Effect.catchCause(() => Effect.succeed(MAIN_AGENT_FAILED)),
                )
            : undefined
      // For a subagent only a clean yes or no from the main agent is an answer, on the main agent's name; anything else
      // is the main agent being unavailable, and the call is refused (S1.33).
      const decided: Decided | undefined =
        forSubagent && asked
          ? asked.decision === "defer" || asked.decidedBy === "system:main_agent_unavailable"
            ? {
                ...MAIN_AGENT_FAILED,
                // The failure code (S1.33). A "not sure" from a model is no clean answer, and reads as one it could not give.
                reason: asked.decidedBy.startsWith("system:") ? (asked.reason ?? "model_error") : "invalid_output",
                attempts: asked.attempts,
                latencyMs: asked.latencyMs,
                costUsd: asked.costUsd,
              }
            : { ...asked, decidedBy: mainAgent, reason: ProjectTrust.printable(asked.reason ?? "", 200) }
          : asked
      // S1.36: a yes counts only on what the main agent may decide: class P, or a call the bypass opened. Never reached
      // while the gate asks for nothing else, and here so that a change elsewhere cannot make it reachable.
      if (decided?.decision === "allow" && verdict.class !== "P" && !overlaid)
        yield* Effect.logError("ignored a yes on a call the decider may not decide", {
          requestID,
          class: verdict.class,
          category: verdict.category,
        })
      const allowed = decided?.decision === "allow" && (verdict.class === "P" || overlaid)
      const judged =
        verdict.class === "P" && decided?.decision !== "allow" && decided?.decision !== "reject"
          ? ("decider_unavailable" as const)
          : verdict.category
      // Nobody is waited for (U11 rule 11): a subagent's run is stopped and its parent decides, a root's run is force
      // stopped. A spend limit is always asked on the root, since the limit is the family's.
      const stopped =
        verdict.class === "B" && needsPerson(input.permission)
          ? root.id === input.sessionID
            ? ("force_stop" as const)
            : ("subagent_stopped" as const)
          : undefined
      const reached = stopped
        ? ("reject" as const)
        : verdict.class === "P"
          ? allowed
            ? ("allow" as const)
            : decided?.decision === "reject"
              ? ("reject" as const)
              : ("defer" as const)
          : forSubagent
            ? allowed
              ? ("allow" as const)
              : ("reject" as const)
            : verdict.class === "A"
            ? ("allow" as const)
            : verdict.class === "B"
              ? ("ask" as const)
              : verdict.class === "X"
                ? ("reject" as const)
                : ("defer" as const)
      const bySession = (session === true || (session === "same" && REPEATABLE.has(judged as string))) && reached === "defer"
      const decision = bySession ? ("allow" as const) : reached

      const reportFull = Effect.gen(function* () {
        const { full } = yield* InstanceState.get(state)
        if (full.has(root.id)) return
        full.add(root.id)
        yield* autonomy
          .record(root.id, { type: "marker", directory, marker: "b0", decidedBy: "system:queue_full" })
          // Logged by record, and the next call that finds it full tries again.
          .pipe(Effect.catch(() => Effect.sync(() => full.delete(root.id))))
      })
      const slot = decision !== "defer" || (yield* hold(root.id, isHeldCategory(judged) ? judged : "not_routine"))
      const queued = slot !== false
      // Added to an entry already shown: its line points there, like any other call that entry stands for (E3).
      const into = typeof slot === "string" ? slot : undefined
      const category = queued ? judged : ("queue_full" as const)

      // Every call that reaches the gate in the mode leaves a line, an ordinary edit too (C58).
      const written = yield* autonomy
        .record(root.id, {
          type: "decision",
          sessionID: input.sessionID,
          requestID,
          messageID: input.tool?.messageID,
          callID: input.tool?.callID,
          agent: input.agent ?? "unknown",
          rootAgent: last?.agent,
          directory,
          permission: input.permission,
          patterns: input.patterns,
          // What it is, not that a person let it through: `decidedBy` says that.
          class: answered ? table.class : verdict.class,
          category,
          risk: typeof input.metadata.risk === "string" ? input.metadata.risk : null,
          canUndo,
          decidedBy: stopped
            ? `system:${stopped}`
            : bySession
              ? "person"
              : (decided?.decidedBy ??
                (overlaid ? mainAgent : verdict.decidedBy === "person" ? "person" : "gate")),
          decision,
          reason: bySession
            ? SESSION_REASON
            : (decided?.reason ??
              (overlaid ? BYPASS_REASON : undefined) ??
              (standing && answered
                ? 'an earlier "always" from a person'
                : verdict === table && via === "outward" && table.destination
                  ? `sent to ${table.destination}`
                  : undefined)),
          memo: decided?.memo,
          latencyMs: decided?.latencyMs,
          costUsd: decided?.costUsd,
          attempts: decided?.attempts,
          via:
            followed || bySession
              ? "grant"
              : into
                ? "duplicate"
                : overlaid
                  ? forSubagent
                    ? "for_subagent"
                    : "main_agent"
                  : verdict === table
                    ? via
                    : undefined,
          // The category the call had before the bypass opened it (S1.32), present only on such a line.
          // 1.1.3: under consent also on a refusal that names it (the belt's, or the table's), so every line keeps it.
          bypassed: overlaid || bypass !== undefined ? verdict.bypassed : undefined,
          duplicateOf: into,
          consentID: verdict === table && via ? table.consentID : undefined,
          // 1.1.1 F26 (P42): where a call the consent let out sends (`host[:port]`, a remote name, a registry or target).
          destination: overlaid ? verdict.destination : undefined,
          script: screen && { bytes: screen.bytes, sha: screen.sha256, flags: [...screen.flags] },
          follows: input.follows,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError("could not record a permission decision", {
              requestID,
              decision,
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        )
      if (!queued) yield* reportFull
      if (stopped) {
        // Logged by record. The run stops either way, and a missing line keeps nothing running.
        yield* autonomy
          .record(root.id, { type: "marker", directory, marker: stopped, decidedBy: "gate" })
          .pipe(Effect.ignore)
        if (stopped === "force_stop") {
          yield* autonomy
            .record(root.id, { type: "marker", directory, marker: "b1", decidedBy: "system:force_stop" })
            .pipe(Effect.ignore)
          // Nothing in this run can go on, and the person hears it now rather than when everything has gone quiet.
          const open = yield* autonomy.openDecisions().pipe(Effect.catchCause(() => Effect.succeed([])))
          yield* events
            .publish(Autonomy.Blocked, {
              sessionID: root.id,
              level: "b1",
              count: open.filter((line) => line.rootID === root.id).length,
            })
            .pipe(Effect.catchCause((cause) => Effect.logError("could not send a notice", { root: root.id, cause })))
        }
        return { class: verdict.class, decision, category, stopped, consented: bypass !== undefined }
      }
      // Nothing runs without a person unless the decision to let it is on record. Refusing or holding needs no such line.
      // Class A grants nothing critical, so its line is a record and not a condition: a failed write is logged and it runs
      // (C26 covers approvals of class P and what a person granted beyond class A). A call the bypass opened was not class
      // A before it, so its line is a condition too.
      if (!written && decision === "allow" && ((answered ? table.class : verdict.class) !== "A" || overlaid)) {
        // 1.1.3: under consent nothing is held. The call is refused at once; the failed write is logged above.
        if (bypass !== undefined)
          return { class: "X" as const, decision: "reject" as const, category: "not_routine" as const, consented: true }
        const again = yield* hold(root.id, "not_routine")
        if (again !== false)
          return {
            class: "D" as const,
            decision: "defer" as const,
            category: "not_routine" as const,
            into: typeof again === "string" ? again : undefined,
          }
        yield* reportFull
        return { class: "D" as const, decision: "defer" as const, category: "queue_full" as const }
      }
      // What the subagent reads when the main agent said no, or could not answer (S1.33).
      const refusal =
        forSubagent && decision === "reject"
          ? decided?.decidedBy === "system:main_agent_unavailable"
            ? MAIN_AGENT_UNAVAILABLE_TEXT
            : mainAgentDeclined(decided?.reason || "no reason given.")
          : undefined
      return { class: verdict.class, decision, category, into, refusal, consented: bypass !== undefined }
    })

    /**
     * A call that is the same as one already held, told so without another entry. In the mode it still gets its own line,
     * pointing at the entry, so every call that left `ask` can be found. False when the root is not in the mode.
     */
    const duplicate = Effect.fnUntraced(function* (
      input: PermissionV1.AskInput,
      requestID: PermissionV1.ID,
      waiting: PendingEntry,
    ) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(input.sessionID)
      const directory = root.directory ?? instance.directory
      yield* autonomy.markMode({ root: root.id, directory })
      if (!(yield* autonomy.check({ root: root.id, directory })).on) return false
      yield* autonomy
        .record(root.id, {
          type: "decision",
          sessionID: input.sessionID,
          requestID,
          messageID: input.tool?.messageID,
          callID: input.tool?.callID,
          agent: input.agent ?? "unknown",
          directory,
          permission: input.permission,
          patterns: input.patterns,
          class: "D",
          category: waiting.category,
          canUndo: input.canUndo ?? false,
          decidedBy: "gate",
          decision: "defer",
          via: "duplicate",
          duplicateOf: waiting.info.id,
        })
        // Nothing is let through here, so a line that cannot be written changes no answer (C26).
        .pipe(
          Effect.catch((error) =>
            Effect.logError("could not record a duplicate request", { requestID, error: error.message }),
          ),
        )
      return true
    })

    /**
     * An ordinary edit no rule asks about never reaches the gate. In the mode it still leaves its class A line (C58). The
     * write is one synchronous append on the same chain, and a failure is only logged: class A grants nothing critical.
     */
    const recordQuiet = Effect.fnUntraced(function* (
      input: PermissionV1.AskInput,
      // E2 (C100): settled by an allow or deny rule, a person's or one Swarm ships. The rule's answer stands, and the line
      // says whose rule it was.
      rule?: { action: "allow" | "deny"; shipped: boolean },
    ) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(input.sessionID)
      const directory = root.directory ?? instance.directory
      yield* autonomy.markMode({ root: root.id, directory })
      if (!(yield* autonomy.check({ root: root.id, directory })).on) return
      yield* autonomy
        .record(root.id, {
          type: "decision",
          sessionID: input.sessionID,
          requestID: input.id ?? PermissionV1.ID.ascending(),
          messageID: input.tool?.messageID,
          callID: input.tool?.callID,
          agent: input.agent ?? "unknown",
          directory,
          permission: input.permission,
          patterns: input.patterns,
          class: rule?.action === "deny" ? "X" : "A",
          risk: typeof input.metadata.risk === "string" ? input.metadata.risk : null,
          canUndo: input.canUndo ?? false,
          decidedBy: rule ? (rule.shipped ? "system:shipped_rule" : "person") : "gate",
          decision: rule?.action === "deny" ? "reject" : "allow",
          reason: rule ? (rule.shipped ? "a rule Swarm ships" : "a rule the person wrote") : undefined,
          follows: input.follows,
        })
        // The rule decided before the mode was asked, so a line that cannot be written changes no answer.
        .pipe(
          Effect.catch((error) =>
            Effect.logError("could not record a call settled before the gate", {
              permission: input.permission,
              error: error.message,
            }),
          ),
        )
    })

    const inMode = Effect.fnUntraced(function* (sessionID: SessionID) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(sessionID)
      return (yield* autonomy.check({ root: root.id, directory: root.directory ?? instance.directory })).on
    })

    /** 1.1.3: whether the person's consent to the bypass applies to this session's root now, as the gate reads it. */
    const bypassNow = Effect.fnUntraced(function* (sessionID: SessionID) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(sessionID)
      const where = { root: root.id, directory: root.directory ?? instance.directory }
      const check = yield* autonomy.check(where)
      if (!check.on || check.externalChange.length > 0) return false
      const consent = yield* autonomy.bypassOf(where).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      return consent !== undefined
    })

    /** How many of the root's consent items a person has allowed. None readable counts as none: nothing is looked at again. */
    const consentGiven = (root: SessionID) =>
      autonomy.consent(root).pipe(
        Effect.map((consent) => consent?.given.size ?? 0),
        Effect.catchCause(() => Effect.succeed(0)),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, away, grants, pending, sessionRules, sessionExact } = yield* InstanceState.get(state)
      const { ruleset, harmless, noAlways, follows, call: toolCall, ...request } = input
      let needsAsk = false
      let userCatchAll = false
      let standing = false
      let personAllowed = false
      // 1.1.4 (U2): a person's "always in this session" is the family's. Looked up only when one was ever given, so a
      // tool that never asks adds no session lookup.
      const remembered =
        !noAlways && sessionRules.size > 0 ? (sessionRules.get((yield* rootOf(request.sessionID)).id) ?? []) : []
      const standingRules = remembered.length > 0 ? [...approved, ...remembered] : approved

      for (const pattern of request.patterns) {
        // 1.2.2 (S163-01): a deny from the call's own ruleset (the agent's rules, with the session's) is final. A standing
        // "always" was given for a call that asked, under whichever agent asked it; it never reopens what another agent,
        // or a later mode such as plan, denies. Only when the ruleset does not deny do the standing grants come in.
        const own = evaluate(request.permission, pattern, ruleset)
        const rule = own.action === "deny" ? own : evaluate(request.permission, pattern, ruleset, noAlways ? [] : standingRules)
        // Not the pattern: for a shell call it is the command, and that can hold a secret typed into its arguments.
        yield* Effect.logInfo("evaluated", { permission: request.permission, action: rule.action })
        if (rule.action === "deny") {
          if (!isShipped(rule)) yield* recordQuiet(input, { action: "deny", shipped: false })
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") {
          if (approved.includes(rule) || remembered.includes(rule)) standing = true
          else if (!isShipped(rule)) personAllowed = true
          continue
        }
        // The shipped baseline asks about anything it does not name. That is for what could hurt, and this cannot.
        // A person who wrote "*": "ask" themselves meant every call, and that is not this rule.
        if (harmless && isShippedCatchAll(rule)) continue
        if (rule.permission === "*" && rule.pattern === "*" && !isShippedCatchAll(rule)) userCatchAll = true
        needsAsk = true
      }

      if (!needsAsk && !standing) {
        // One line either way (E2, C58): a person's rule is named as theirs, an ordinary edit as the gate's. A built-in
        // rule's exit is never credited to the person; it leaves no line, as the read tools' exits always have (XF-02).
        if (personAllowed) yield* recordQuiet(input, { action: "allow", shipped: false })
        else if (input.editClass === "ordinary") yield* recordQuiet(input)
        return
      }

      const id = request.id ?? PermissionV1.ID.ascending()
      // As the event stream already sends it. The list route encodes every request or none, and rejects what JSON cannot
      // say, such as the `undefined` of a tool parameter left out: one of those would hide every prompt in the folder.
      const metadata = yield* Effect.try({
        try: () => JSON.parse(JSON.stringify(request.metadata)) as Record<string, unknown>,
        catch: String,
      }).pipe(Effect.orElseSucceed(() => ({})))
      // Which call this is, to the letter. What cannot be written down is a call no answer was ever about.
      const call = yield* Effect.try({ try: () => JSON.stringify(toolCall ?? request.metadata), catch: String }).pipe(
        Effect.orElseSucceed(() => id),
      )
      // A grant and a held entry belong to the family, so what a root was allowed or is waiting on covers its subagents.
      const family = (yield* rootOf(request.sessionID)).id
      const matching = grants.findIndex(
        (grant) => grant.root === family && samePrompt(grant, request) && grant.call === call && grant.uses !== "same",
      )
      const unbound = grants.findIndex(
        (grant) => grant.root === family && samePrompt(grant, request) && grant.call === undefined && !grant.uses,
      )
      const repeat = grants.findIndex(
        (grant) => grant.uses === "once" && grant.sessionID === request.sessionID && samePrompt(grant, request),
      )
      // A person's "always in this session" (row 258) is good for the family, in the run of the mode it was given in. The
      // gate still judges the call, and only what it would hold runs on it. A call its tool offers no "always" for (one the
      // shell scan flags, say) is never covered by one.
      const since = yield* autonomy.modeSince(family)
      const covering = (repeatOnly: boolean) =>
        since !== undefined &&
        !noAlways &&
        request.always.length > 0 &&
        grants.some(
          (grant) =>
            grant.uses === "session" &&
            Boolean(grant.repeatOnly) === repeatOnly &&
            grant.root === family &&
            grant.since === since &&
            withinSession(grant, request),
        )
      // Row 278: the very call a person said yes to before, or the same kind of call, in this run of the mode.
      const inSame =
        since !== undefined &&
        (covering(true) ||
          grants.some(
            (grant) =>
              grant.uses === "same" && grant.root === family && grant.since === since && samePrompt(grant, request) && grant.call === call,
          ))
      const inSession = covering(false) ? true : inSame ? ("same" as const) : false
      // Turned off since, even if on again now, and it answers nothing: it was given for the run that was going then.
      const current =
        repeat >= 0 &&
        (yield* inMode(request.sessionID)) &&
        (yield* autonomy.modeSince(family)) === grants[repeat]!.since
      const granted =
        matching >= 0 ? matching : current ? repeat : unbound >= 0 && !(yield* inMode(request.sessionID)) ? unbound : -1
      const asked: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata,
        always: request.always,
        tool: request.tool,
      }
      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      // Held for the person with the agent already released, whatever the unattended wait is set to. The request shows no
      // "always": one would write a rule beyond the mode. Its patterns are kept on the entry, and in `sessionAlways` for the
      // app, for an "always in this session" that ends with the run of the mode (row 258).
      // The state as it is now: the folder may have been closed and opened while the decider was thinking.
      const held: HeldCall = { requestID: id, sessionID: request.sessionID, call, follows }
      const hold = (root: SessionID, category: PermissionV1.DeferredCategory) =>
        Effect.all([InstanceState.get(state), consentGiven(root)]).pipe(
          Effect.map(([current, given]): boolean | PermissionV1.ID => {
            // One entry per root, permission and patterns (E3). Another call joins its list, and the entry shows it, with
            // the list's new version for the answer to name. A full list starts another entry rather than lose a call.
            // Only an open entry: one a person answered is gone from `pending`, so nothing can join it.
            const joined = [...current.pending.values()].find(
              (item) =>
                item.root === root &&
                item.info.movedOnAt &&
                item.calls !== undefined &&
                item.calls.length < QUEUE_LIMIT &&
                samePrompt(item.info, asked),
            )
            // Back at the gate after a consent tick and held all the same: already on the list, so the version stays.
            if (joined?.calls?.some((other) => other.call === call)) {
              current.pending.set(joined.info.id, { ...joined, given })
              return joined.info.id
            }
            if (joined?.calls) {
              const calls = [...joined.calls, held]
              const version = (joined.version ?? joined.calls.length) + 1
              current.pending.set(joined.info.id, {
                ...joined,
                given,
                calls,
                version,
                asks: new Map([...(joined.asks ?? []), [call, { input, userCatchAll }]]),
                info: {
                  ...joined.info,
                  metadata: { ...joined.info.metadata, calls: shownCalls(calls), version },
                },
              })
              return joined.info.id
            }
            if ([...current.pending.values()].filter((item) => item.root === root).length >= QUEUE_LIMIT) return false
            const always = noAlways || request.always.length === 0 ? undefined : [...request.always]
            // The person answers this one and not the next, so the entry has to show all of what the answer is good for.
            const shown = toolCall && call !== id ? { ...metadata, call: JSON.parse(call) } : metadata
            // Only the server names it: a tool's own metadata cannot offer the app a button. Left out rather than
            // undefined, which the list route cannot encode.
            const plain = Object.fromEntries(Object.entries(shown).filter(([key]) => key !== "sessionAlways"))
            const moved: PermissionV1.Request = {
              ...asked,
              metadata: always ? { ...plain, sessionAlways: always } : plain,
              always: [],
              movedOnAt: Date.now(),
              deferred: true,
            }
            current.pending.set(id, {
              info: moved,
              deferred,
              noAlways,
              follows,
              category,
              root,
              calls: [held],
              given,
              asks: new Map([[call, { input, userCatchAll }]]),
              always,
            })
            return true
          }),
        )
      const stayHeld = Effect.fnUntraced(function* (gated: { category?: string; into?: PermissionV1.ID }) {
        const category = isHeldCategory(gated.category) ? gated.category : "not_routine"
        const entry = (yield* InstanceState.get(state)).pending.get(gated.into ?? id)
        yield* Effect.logInfo("held", { id, permission: asked.permission, category })
        if (entry) yield* events.publish(Event.Asked, entry.info)
        return yield* new PermissionV1.DeferredError({ category })
      })
      // 1.1.3: the gate's answer as the agent reads it. Under consent a refusal uses the consented texts, and anything that
      // would still wait is refused at once with `UNJUDGED_TEXT`: no DeferredError on the consented path.
      const refusedBy = (gated: { category?: string; consented?: boolean }) =>
        gated.consented ? refusedUnderConsent(gated.category) : refusedByMode(gated.category)
      const heldOrRefused = Effect.fnUntraced(function* (gated: {
        category?: string
        into?: PermissionV1.ID
        consented?: boolean
      }) {
        if (!gated.consented) return yield* stayHeld(gated)
        yield* Effect.logError("a consented call would have waited", { id, permission: asked.permission, category: gated.category })
        return yield* refusedUnderConsent("not_routine")
      })
      if (!needsAsk) {
        const gated = yield* gate(input, id, userCatchAll, hold, false, true)
        if (gated?.class === "X") return yield* refusedBy(gated)
        if (gated?.refusal !== undefined) return yield* mainAgentRefused(gated.refusal)
        if (gated?.decision === "defer") return yield* heldOrRefused(gated)
        return
      }
      if (granted >= 0) {
        const [used] = grants.splice(granted, 1)
        // A person answered for this call, on its own entry or one that showed it. It still gets its line in the mode, and
        // what it is can still refuse it.
        const gated = yield* gate(input, id, userCatchAll, hold, true)
        if (gated?.class === "X") return yield* refusedBy(gated)
        if (gated?.refusal !== undefined) return yield* mainAgentRefused(gated.refusal)
        if (gated?.decision === "defer") return yield* heldOrRefused(gated)
        // The entry back from a restart had lost what else this call asks (a shell read beyond the folder asks `bash`
        // next). The person approved the call, so each of those prompts of this very call is let through once, as on an
        // entry that still showed them.
        if (used?.uses)
          for (const next of follows ?? [])
            grants.push({
              sessionID: request.sessionID,
              root: family,
              permission: next.permission,
              patterns: next.patterns,
              call,
              followed: true,
            })
        return
      }
      // Already waiting for the user's decision on exactly this. Asking again would only add a wait and a second row.
      // What autonomous mode held is the family's: the same call from a subagent is this call too. Other content for the
      // same path is another call, which joins the entry's list through the gate, unless the entry came back from a
      // restart and no longer knows.
      const waiting = [...pending.values()].find(
        (item) =>
          item.info.movedOnAt &&
          (item.root ? item.root === family && samePrompt(item.info, request) : sameRequest(item.info, request)) &&
          (item.calls === undefined || item.calls.some((other) => other.call === call)),
      )
      // 1.1.3 (matrix row 54): under consent no shortcut to a held entry; the call is judged afresh by its own row.
      const consentedNow = waiting !== undefined && (yield* bypassNow(request.sessionID))
      if (waiting && !waiting.category && !consentedNow) {
        yield* duplicate(input, id, waiting)
        return yield* new PermissionV1.AwayError()
      }
      // With the mode off the entry stays answerable, and this is a new request that gets an ordinary prompt.
      // A consent item ticked since the entry was held may be what it waits on (C98): the gate looks again, and holding it
      // still adds the call to that entry without a new version.
      const ticked =
        waiting?.root !== undefined &&
        waiting.given !== undefined &&
        (yield* consentGiven(waiting.root)) > waiting.given
      if (waiting?.category && !ticked && !consentedNow && (yield* duplicate(input, id, waiting)))
        return yield* new PermissionV1.DeferredError({ category: waiting.category })

      // A session's "always" covers this prompt only. What else this call asks (a shell read beyond the folder asks `bash`
      // next) is another call than the one the person saw, so it is judged, and held, on its own.
      const gated = yield* gate(input, id, userCatchAll, hold, false, false, inSession)
      if (gated?.decision === "allow") return
      if (gated?.stopped) return yield* stoppedByMode(input)
      // Refused by what it is, so no person is asked. Not a rejection: that error ends the run, and this one reports back.
      if (gated?.class === "X") return yield* refusedBy(gated)
      // S1.37: the main agent's no to a subagent has its own text; the 1.1.0 class P no keeps its fixed one.
      if (gated?.refusal !== undefined) return yield* mainAgentRefused(gated.refusal)
      if (gated?.decision === "reject") return yield* new DeciderRefusedError({ ruleset: [] })
      // 1.1.4: a person's exact "always in this session" on a prompt that offered none. Only with the mode off for the
      // root (`gate` answers undefined only then), so it never changes what autonomous mode does.
      if (gated === undefined && exactCovers(sessionExact.get(family), request)) return

      // A repeating call stops the run on purpose until a person looks. Carrying on would defeat that guard.
      // The same goes for a spend limit: nobody being there is exactly when it must hold.
      const wait = needsPerson(request.permission) ? undefined : Unattended.wait(away.has(family))
      // P-03: the family is away (one of its requests went unanswered, none answered since), so this one is queued at
      // once, listed and answerable, instead of each ask of the task waiting again. Before that, asks wait as before.
      const queued = wait !== undefined && away.has(family)
      const info: PermissionV1.Request = wait ? { ...asked, movesOnAt: Date.now() + wait } : asked
      yield* Effect.logInfo("asking", { id, permission: info.permission })

      if (gated?.decision === "defer") return yield* heldOrRefused(gated)
      const offMode = gated === undefined ? ({ offMode: true } as const) : {}
      if (!queued) {
        pending.set(id, { info, deferred, noAlways, follows, ...offMode })
        yield* events.publish(Event.Asked, info)
      }
      const moveOn = Effect.gen(function* () {
        // The request stays listed and answerable. The agent is released, not the decision.
        const moved: PermissionV1.Request = { ...asked, movedOnAt: Date.now() }
        pending.set(id, { info: moved, deferred, noAlways, follows, ...offMode })
        away.add(family)
        yield* Effect.logInfo("moved on", { id, permission: info.permission })
        yield* events.publish(Event.Asked, moved)
        // An unattended night can skip far more of these than anyone will read. The oldest are the least likely to matter.
        // Not in autonomous mode, where a decision is only ever settled by a person, and never what that mode held.
        const skipped = (yield* inMode(request.sessionID))
          ? []
          : [...pending.values()].filter(
              (item) => item.info.movedOnAt && !item.root && item.info.sessionID === request.sessionID,
            )
        for (const item of skipped.slice(0, Math.max(0, skipped.length - MAX_SKIPPED))) {
          pending.delete(item.info.id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
        }
        return yield* new PermissionV1.AwayError()
      })
      const answered = wait
        ? Effect.raceFirst(Deferred.await(deferred), Effect.sleep(wait).pipe(Effect.andThen(moveOn)))
        : Deferred.await(deferred)
      return yield* Effect.ensuring(
        queued ? moveOn : answered,
        Effect.sync(() => {
          if (!pending.get(id)?.info.movedOnAt) pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (
      input: PermissionV1.ReplyInput & { abandoned?: boolean; version?: number },
    ) {
      const { approved, away, grants, pending, sessionRules, sessionExact } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
      // A yes is good for the list the person saw. One that grew since is shown again, unanswered, and nothing is let
      // through. An answer without a version counts as version 1, which is all an entry showed until it grew.
      const listed = existing.version ?? existing.calls?.length ?? 1
      if (input.reply !== "reject" && listed > 1 && (input.version ?? 1) !== listed) {
        yield* Effect.logInfo("shown again", { id: existing.info.id, version: input.version ?? 1, listed })
        yield* events.publish(Event.Asked, existing.info)
        return undefined
      }

      pending.delete(input.requestID)
      // P-03: a reply to any request of the family means somebody is there; the family's next ask waits again.
      away.delete(existing.root ?? (yield* rootOf(existing.info.sessionID)).id)
      if (input.abandoned) yield* close(existing, "abandoned", "system:session_closed")
      else yield* close(existing, input.reply === "reject" ? "rejected_later" : "approved_later", "person")
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      const answered = (entry: PendingEntry): Answered => ({
        ...entry.info,
        ...(entry.follows && { follows: entry.follows }),
        ...(entry.calls && { call: entry.calls[0]!.call, calls: entry.calls }),
      })
      // 1.1.4 (U2): an "always" outside autonomous mode is the session family's, never the whole project's. The tool's own
      // "always" patterns when it offered some; otherwise the very prompt, matched to the letter. A spend limit keeps no
      // "always" in any form (Q1): the answer there is a "once", and nothing is stored.
      const remember = Effect.fnUntraced(function* (entry: PendingEntry) {
        if (entry.info.permission === "spend_limit") return
        const root = (yield* rootOf(entry.info.sessionID)).id
        if (!entry.noAlways && entry.info.always.length > 0) {
          const rules = sessionRules.get(root) ?? []
          for (const pattern of entry.info.always)
            rules.push({ permission: entry.info.permission, pattern, action: "allow" })
          sessionRules.set(root, rules)
          return
        }
        const rules = sessionExact.get(root) ?? []
        const workdir = workdirOf(entry.info)
        rules.push({ permission: entry.info.permission, patterns: [...entry.info.patterns], ...(workdir !== undefined && { workdir }) })
        sessionExact.set(root, rules)
      })
      // A moved-on prompt the mode did not hold: its "always" is remembered for the session, as on a prompt still open.
      if (existing.info.movedOnAt && existing.root === undefined) {
        if (input.reply === "always") yield* remember(existing)
        return answered(existing)
      }
      if (existing.info.movedOnAt) {
        if (input.reply === "always")
          approved.push(
            ...existing.info.always.map((pattern) => ({
              permission: existing.info.permission,
              pattern,
              action: "allow" as const,
            })),
          )
        // What the mode held writes no rule: an "always" on it is good for its family until the mode goes off (row 258).
        // Its other entries the same "always" covers are approved with it, as the loop below does for ordinary prompts.
        const root = existing.root
        const always = existing.always
        // Row 278: a plain yes on a hold that is only about a call not being routine yet is good, for the rest of this run
        // of the mode, for the very calls it saw and for the same kind of call: the request's own "always" patterns, as an
        // "always in this session" would be, but each later call still has to be held for a repeatable reason. Entries of
        // the family that either covers are approved with it.
        const plainYes = input.reply === "once" && root !== undefined && repeatable(existing)
        if ((input.reply !== "always" && !plainYes) || !root) return answered(existing)
        const since = yield* autonomy.modeSince(root)
        const seen = new Set((plainYes ? (existing.calls ?? []) : []).map((item) => item.call))
        for (const call of seen)
          grants.push({ sessionID: existing.info.sessionID, root, permission: existing.info.permission, patterns: existing.info.patterns, call, uses: "same", since })
        const scope = always && (input.reply === "always" || !existing.noAlways) ? { permission: existing.info.permission, patterns: always } : undefined
        if (scope) grants.push({ sessionID: existing.info.sessionID, root, ...scope, uses: "session", since, ...(plainYes && { repeatOnly: true }) })
        if (!scope && seen.size === 0) return answered(existing)
        const released: Answered[] = []
        for (const [id, item] of pending.entries()) {
          if (item.root !== root || !item.info.movedOnAt) continue
          const bySame = seen.size > 0 && samePrompt(item.info, existing.info) && (item.calls ?? []).length > 0 && item.calls!.every((other) => seen.has(other.call))
          const byScope = scope !== undefined && !item.noAlways && withinSession(scope, item.info) && (!plainYes || repeatable(item))
          if (!bySame && !byScope) continue
          pending.delete(id)
          yield* close(item, "approved_later", "person")
          yield* events.publish(Event.Replied, { sessionID: item.info.sessionID, requestID: id, reply: input.reply })
          released.push(answered(item))
        }
        return { ...answered(existing), ...(released.length > 0 && { released }) }
      }

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID || item.info.movedOnAt) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      yield* remember(existing)
      // Other prompts of the same session this answer, or one before it, covers are approved with it.
      const root = (yield* rootOf(existing.info.sessionID)).id
      const standingRules = [...approved, ...(sessionRules.get(root) ?? [])]
      const exact = sessionExact.get(root)
      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID || item.info.movedOnAt) continue
        const byRule =
          !item.noAlways &&
          item.info.patterns.every(
            (pattern) => evaluate(item.info.permission, pattern, standingRules).action === "allow",
          )
        const byExact = item.offMode === true && exactCovers(exact, item.info)
        if (!byRule && !byExact) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const grant = Effect.fn("Permission.grant")(function* (input: Grant) {
      const { grants } = yield* InstanceState.get(state)
      const root = yield* rootOf(input.sessionID)
      grants.push({
        sessionID: input.sessionID,
        root: root.id,
        permission: input.permission,
        patterns: input.patterns,
        followed: input.followed,
        call: input.call,
        ...(input.uses && { uses: input.uses, since: yield* autonomy.modeSince(root.id) }),
      })
    })

    /**
     * A person ticked consent items of this root's list (C98). Each open entry is looked at again by the table: a call the
     * tick now lets through (class A via consent or outward) leaves the list with its line, and an entry with nothing left
     * is closed as approved. What comes back is for the caller to act on as on a person's approval, which runs those calls.
     */
    const consentTicked = Effect.fn("Permission.consentTicked")(function* (root: SessionID) {
      const { away, pending } = yield* InstanceState.get(state)
      const instance = yield* InstanceState.context
      const directory = (yield* rootOf(root)).directory ?? instance.directory
      const given = yield* consentGiven(root)
      const open = [...pending.values()].filter(
        (item) => item.root === root && item.info.movedOnAt && item.calls !== undefined && item.asks !== undefined,
      )
      const answers: Answered[] = []
      for (const entry of open) {
        const covered: {
          held: HeldCall
          asked: PermissionV1.AskInput
          covered: Effect.Success<ReturnType<typeof judge>> & { via: "consent" | "outward" }
        }[] = []
        for (const held of entry.calls!) {
          const asked = entry.asks!.get(held.call)
          if (!asked) continue
          const result = yield* judge(asked.input, asked.userCatchAll, root)
          if (result.table.class === "A" && result.via)
            covered.push({ held, asked: asked.input, covered: { ...result, via: result.via } })
        }
        // Looked at for this tick: a repeat joins it again without the gate until the next one.
        pending.set(entry.info.id, { ...entry, given })
        if (covered.length === 0) continue
        for (const item of covered)
          yield* autonomy
            .record(root, {
              type: "decision",
              sessionID: item.held.sessionID,
              requestID: item.held.requestID,
              agent: "person",
              rootAgent: item.covered.last?.agent,
              directory,
              permission: item.asked.permission,
              patterns: item.asked.patterns,
              class: "A",
              category: item.covered.table.category ?? "consented",
              canUndo: item.covered.canUndo,
              decidedBy: "person",
              decision: "allow",
              via: item.covered.via,
              consentID: item.covered.table.consentID,
              reason: "a consent item the person ticked after it was held",
            })
            // Logged by record. The call still goes through the gate when it runs, and leaves its own line then.
            .pipe(Effect.ignore)
        const rest = entry.calls!.filter((held) => !covered.some((item) => item.held === held))
        const calls = covered.map((item) => item.held)
        if (rest.length === 0) {
          pending.delete(entry.info.id)
          away.delete(root)
          yield* close(entry, "approved_later", "person")
          yield* events.publish(Event.Replied, {
            sessionID: entry.info.sessionID,
            requestID: entry.info.id,
            reply: "once",
          })
          answers.push({ ...entry.info, follows: calls[0]!.follows, call: calls[0]!.call, calls })
          continue
        }
        // Some calls are still waiting: the list shows only those, under a new version.
        const version = (entry.version ?? entry.calls!.length) + 1
        const first = rest[0]!
        const info: PermissionV1.Request = {
          ...entry.info,
          metadata: {
            ...entry.info.metadata,
            ...(entry.info.metadata.call !== undefined && { call: JSON.parse(first.call) }),
            calls: shownCalls(rest),
            version,
          },
        }
        pending.set(entry.info.id, {
          ...entry,
          info,
          follows: first.follows,
          given,
          version,
          calls: rest,
          asks: new Map([...entry.asks!].filter(([call]) => rest.some((held) => held.call === call))),
        })
        yield* events.publish(Event.Asked, info)
        answers.push({ ...entry.info, follows: calls[0]!.follows, call: calls[0]!.call, calls })
      }
      return answers
    })

    return Service.of({ ask, reply, grant, list, consentTicked })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

/** `shipped` is for the rules Swarm itself brings (the agents' own): their line in the mode credits them, not the person (E2). */
export function fromConfig(permission: ConfigPermissionV1.Info, options?: { shipped?: boolean }) {
  const ruleset: PermissionV1.Rule[] = []
  const userCatchAll = USER_CATCH_ALL in permission
  const mark = (rule: PermissionV1.Rule, pattern: string) => {
    if (options?.shipped || (!(rule.permission === "*" && userCatchAll) && isBaselineRule(rule.permission, pattern, rule.action)))
      shippedRules.add(rule)
    return rule
  }
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      const rule = mark({ permission: key, action: value, pattern: "*" }, "*")
      if (key === "*" && value === "ask" && !userCatchAll) shippedCatchAll.add(rule)
      ruleset.push(rule)
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) =>
        mark({ permission: key, pattern: expand(pattern), action }, pattern),
      ),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const deciderNode = LayerNode.make({
  service: Decider,
  layer: Layer.effect(
    Decider,
    Effect.map(AutonomyDecider.Service, (decider) => Decider.of({ decide: decider.decide })),
  ),
  deps: [AutonomyDecider.node],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Session.node, Autonomy.node, deciderNode],
})

export * as Permission from "."
