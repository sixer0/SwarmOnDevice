import { needsPerson } from "@opencode-ai/core/permission/needs-person"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context, Option, Schema } from "effect"
import os from "os"
import path from "path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { Autonomy } from "./autonomy"
import { AutonomyDecider } from "./autonomy-decider"
import { AutonomyTable } from "./autonomy-table"
import type { ScriptScreen } from "./script-screen"
import { Unattended } from "./unattended"

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
}

export interface Grant extends Pick<PermissionV1.Request, "sessionID" | "permission" | "patterns"> {
  /** Came along with another request's answer, on the entry that showed this call. A refusal still holds for it. */
  followed?: boolean
  /** The exact call this answer was about. Without it, it is an answer from outside autonomous mode and means nothing inside. */
  call?: string
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
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  /** Each with the root of the session it was given to: an answer at the root is good for its subagents too. */
  grants: (Grant & { root: SessionID })[]
  /** Sessions whose last request went unanswered: nobody is there, so the next one is not worth a long wait. */
  away: Set<PermissionV1.Request["sessionID"]>
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

/** Class X. Nobody wrote a rule and nobody can answer this, so the text says neither. */
class RefusedByModeError extends PermissionV1.DeniedError {
  override get message() {
    return "This call did not run. Autonomous mode never allows this kind of call, whoever is asked. Do not try to get the same effect another way. Carry on with everything that does not depend on it, and list what was refused in your final message."
  }
}

/** Class X for a write out of the folder (U11 rule 1). The way on is a copy inside the project, so the text names it. */
class RefusedOutsideWriteError extends RefusedByModeError {
  override get message() {
    return "This call did not run. Autonomous mode never writes outside the project folder. Copy the file into the project first and change the copy there; the original is not changed. Carry on with everything that does not depend on it, and list what was refused in your final message."
  }
}

/**
 * U11 rule 11: in the mode a spend limit or a repeating call waits for nobody. It ends the run, so it is a rejection.
 * The prefix is `SUBAGENT_STOPPED` in `tool/task.ts`, which turns a subagent's run ended by it into text for its parent;
 * importing it here would pull every tool into the permission service.
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
    input.permission === "doom_loop"
      ? `Stopped by autonomous mode: repeated calls to \`${input.patterns[0] ?? "a tool"}\`.`
      : "Stopped by autonomous mode: the spend limit was reached."
  return error
}

const refusedByMode = (category: string | undefined) =>
  category === "outside_write" ? new RefusedOutsideWriteError({ ruleset: [] }) : new RefusedByModeError({ ruleset: [] })

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
    ) => Effect.Effect<Decided>
  }
>()("@opencode/PermissionDecider") {}

const UNDECIDED: Decided = { decision: "defer", decidedBy: "system:decider_unavailable" }

const held = (category: AutonomyTable.HeldCategory): AutonomyTable.Verdict => ({
  class: "D",
  decidedBy: "gate",
  category,
})

const isHeldCategory = Schema.is(PermissionV1.DeferredCategory)
const decodeRequest = Schema.decodeUnknownOption(PermissionV1.Request)

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
    ) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(input.sessionID)
      const directory = root.directory ?? instance.directory
      yield* autonomy.markMode({ root: root.id, directory })
      const check = yield* autonomy.check({ root: root.id, directory })
      if (!check.on) return undefined

      // Undefined when it could not be read, and a lineage nobody can place is held to the plan agent's limits.
      const last = yield* sessions
        .findMessage(root.id, (message) => message.info.role === "user")
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
      const table = yield* Effect.try({
        // `harmless` stays out: such a call only gets here when a rule naming its permission asked about it.
        try: () =>
          AutonomyTable.classify({
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
          }),
        catch: String,
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("could not classify a permission request", { permission: input.permission, error }).pipe(
            Effect.as(held("not_routine")),
          ),
        ),
      )
      // An "always" on what the mode lets anyway answers nothing: an ordinary edit is on record as the gate's, not a person's.
      const answered =
        (followed || standing) &&
        table.class !== "X" &&
        !(standing && !followed && table.class === "A" && input.editClass === "ordinary")
      // Relative paths in a command mean nothing until its real folder is known, so no decider sees it without one.
      const placed = table.class === "P" && input.permission === "bash" && !cwd ? held("not_routine") : table
      const verdict: AutonomyTable.Verdict = answered
        ? { ...table, class: "A", decidedBy: "person" }
        : Autonomy.afterCheck(placed.class, check) === placed.class
          ? placed
          : held("not_routine")
      const decided =
        verdict.class === "P"
          ? yield* decider.decide(input, root.id, verdict.category).pipe(
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
          : undefined
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
      const decision = stopped
        ? ("reject" as const)
        : verdict.class === "P"
          ? decided?.decision === "allow" || decided?.decision === "reject"
            ? decided.decision
            : ("defer" as const)
          : verdict.class === "A"
            ? ("allow" as const)
            : verdict.class === "B"
              ? ("ask" as const)
              : verdict.class === "X"
                ? ("reject" as const)
                : ("defer" as const)

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
            : (decided?.decidedBy ?? (verdict.decidedBy === "person" ? "person" : "gate")),
          decision,
          reason: decided?.reason ?? (standing && answered ? "an earlier \"always\" from a person" : undefined),
          memo: decided?.memo,
          latencyMs: decided?.latencyMs,
          costUsd: decided?.costUsd,
          attempts: decided?.attempts,
          via: followed ? "grant" : into ? "duplicate" : undefined,
          duplicateOf: into,
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
        yield* autonomy.record(root.id, { type: "marker", directory, marker: stopped, decidedBy: "gate" }).pipe(Effect.ignore)
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
        return { class: verdict.class, decision, category, stopped }
      }
      // Nothing runs without a person unless the decision to let it is on record. Refusing or holding needs no such line.
      // Class A grants nothing critical, so its line is a record and not a condition: a failed write is logged and it runs
      // (C26 covers approvals of class P and what a person granted beyond class A).
      if (!written && decision === "allow" && (answered ? table.class : verdict.class) !== "A") {
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
      return { class: verdict.class, decision, category, into }
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
    const recordQuiet = Effect.fnUntraced(function* (input: PermissionV1.AskInput) {
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
          class: "A",
          risk: typeof input.metadata.risk === "string" ? input.metadata.risk : null,
          canUndo: input.canUndo ?? false,
          decidedBy: "gate",
          decision: "allow",
          follows: input.follows,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logError("could not record a class A call", { permission: input.permission, error: error.message }),
          ),
        )
    })

    const inMode = Effect.fnUntraced(function* (sessionID: SessionID) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(sessionID)
      return (yield* autonomy.check({ root: root.id, directory: root.directory ?? instance.directory })).on
    })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, away, grants, pending } = yield* InstanceState.get(state)
      const { ruleset, harmless, noAlways, follows, call: toolCall, ...request } = input
      let needsAsk = false
      let userCatchAll = false
      let standing = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, noAlways ? [] : approved)
        // Not the pattern: for a shell call it is the command, and that can hold a secret typed into its arguments.
        yield* Effect.logInfo("evaluated", { permission: request.permission, action: rule.action })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") {
          if (approved.includes(rule)) standing = true
          continue
        }
        // The shipped baseline asks about anything it does not name. That is for what could hurt, and this cannot.
        // A person who wrote "*": "ask" themselves meant every call, and that is not this rule.
        if (harmless && isShippedCatchAll(rule)) continue
        if (rule.permission === "*" && rule.pattern === "*" && !isShippedCatchAll(rule)) userCatchAll = true
        needsAsk = true
      }

      if (!needsAsk && !standing) {
        if (input.editClass === "ordinary") yield* recordQuiet(input)
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
      const matching = grants.findIndex((grant) => grant.root === family && samePrompt(grant, request) && grant.call === call)
      const unbound = grants.findIndex(
        (grant) => grant.root === family && samePrompt(grant, request) && grant.call === undefined,
      )
      const granted = matching >= 0 ? matching : unbound >= 0 && !(yield* inMode(request.sessionID)) ? unbound : -1
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
      // Held for the person with the agent already released, whatever the unattended wait is set to. An "always" on one
      // of these would open more than the single call anyone looked at, so it has nothing to apply to.
      // The state as it is now: the folder may have been closed and opened while the decider was thinking.
      const held: HeldCall = { requestID: id, sessionID: request.sessionID, call, follows }
      const hold = (root: SessionID, category: PermissionV1.DeferredCategory) =>
        InstanceState.get(state).pipe(
          Effect.map((current): boolean | PermissionV1.ID => {
            // One entry per root, permission and patterns (E3). Another call joins its list, and the entry shows it, with
            // the list's new version for the answer to name. A full list starts another entry rather than lose a call.
            const joined = [...current.pending.values()].find(
              (item) =>
                item.root === root &&
                item.info.movedOnAt &&
                item.calls !== undefined &&
                item.calls.length < QUEUE_LIMIT &&
                samePrompt(item.info, asked),
            )
            if (joined?.calls) {
              const calls = [...joined.calls, held]
              current.pending.set(joined.info.id, {
                ...joined,
                calls,
                info: {
                  ...joined.info,
                  metadata: { ...joined.info.metadata, calls: shownCalls(calls), version: calls.length },
                },
              })
              return joined.info.id
            }
            if ([...current.pending.values()].filter((item) => item.root === root).length >= QUEUE_LIMIT) return false
            const moved: PermissionV1.Request = {
              ...asked,
              // The person answers this one and not the next, so the entry has to show all of what the answer is good for.
              metadata: toolCall && call !== id ? { ...metadata, call: JSON.parse(call) } : metadata,
              always: [],
              movedOnAt: Date.now(),
              deferred: true,
            }
            current.pending.set(id, { info: moved, deferred, noAlways, follows, category, root, calls: [held] })
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
      if (!needsAsk) {
        const gated = yield* gate(input, id, userCatchAll, hold, false, true)
        if (gated?.class === "X") return yield* refusedByMode(gated.category)
        if (gated?.decision === "defer") return yield* stayHeld(gated)
        return
      }
      if (granted >= 0) {
        grants.splice(granted, 1)
        // A person answered for this call, on its own entry or one that showed it. It still gets its line in the mode, and
        // what it is can still refuse it.
        const gated = yield* gate(input, id, userCatchAll, hold, true)
        if (gated?.class === "X") return yield* refusedByMode(gated.category)
        if (gated?.decision === "defer") return yield* stayHeld(gated)
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
      if (waiting && !waiting.category) {
        yield* duplicate(input, id, waiting)
        return yield* new PermissionV1.AwayError()
      }
      // With the mode off the entry stays answerable, and this is a new request that gets an ordinary prompt.
      if (waiting?.category && (yield* duplicate(input, id, waiting)))
        return yield* new PermissionV1.DeferredError({ category: waiting.category })

      const gated = yield* gate(input, id, userCatchAll, hold)
      if (gated?.decision === "allow") return
      if (gated?.stopped) return yield* stoppedByMode(input)
      // Refused by what it is, so no person is asked. Not a rejection: that error ends the run, and this one reports back.
      if (gated?.class === "X") return yield* refusedByMode(gated.category)
      if (gated?.decision === "reject") return yield* new DeciderRefusedError({ ruleset: [] })

      // A repeating call stops the run on purpose until a person looks. Carrying on would defeat that guard.
      // The same goes for a spend limit: nobody being there is exactly when it must hold.
      const wait = needsPerson(request.permission) ? undefined : Unattended.wait(away.has(request.sessionID))
      const info: PermissionV1.Request = wait ? { ...asked, movesOnAt: Date.now() + wait } : asked
      yield* Effect.logInfo("asking", { id, permission: info.permission })

      if (gated?.decision === "defer") return yield* stayHeld(gated)
      pending.set(id, { info, deferred, noAlways, follows })
      yield* events.publish(Event.Asked, info)
      const moveOn = Effect.gen(function* () {
        // The request stays listed and answerable. The agent is released, not the decision.
        const moved: PermissionV1.Request = { ...asked, movedOnAt: Date.now() }
        pending.set(id, { info: moved, deferred, noAlways, follows })
        away.add(request.sessionID)
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
      return yield* Effect.ensuring(
        wait
          ? Effect.raceFirst(Deferred.await(deferred), Effect.sleep(wait).pipe(Effect.andThen(moveOn)))
          : Deferred.await(deferred),
        Effect.sync(() => {
          if (!pending.get(id)?.info.movedOnAt) pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (
      input: PermissionV1.ReplyInput & { abandoned?: boolean; version?: number },
    ) {
      const { approved, away, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
      // A yes is good for the list the person saw. One that grew since is shown again, unanswered, and nothing is let
      // through. An answer without a version counts as version 1, which is all an entry showed until it grew.
      const listed = existing.calls?.length ?? 1
      if (input.reply !== "reject" && listed > 1 && (input.version ?? 1) !== listed) {
        yield* Effect.logInfo("shown again", { id: existing.info.id, version: input.version ?? 1, listed })
        yield* events.publish(Event.Asked, existing.info)
        return undefined
      }

      pending.delete(input.requestID)
      away.delete(existing.info.sessionID)
      if (input.abandoned) yield* close(existing, "abandoned", "system:session_closed")
      else yield* close(existing, input.reply === "reject" ? "rejected_later" : "approved_later", "person")
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (existing.info.movedOnAt) {
        if (input.reply === "always")
          approved.push(
            ...existing.info.always.map((pattern) => ({
              permission: existing.info.permission,
              pattern,
              action: "allow" as const,
            })),
          )
        return {
          ...existing.info,
          ...(existing.follows && { follows: existing.follows }),
          ...(existing.calls && { call: existing.calls[0]!.call, calls: existing.calls }),
        }
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

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID || item.info.movedOnAt || item.noAlways) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
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
      })
    })

    return Service.of({ ask, reply, grant, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      const rule = { permission: key, action: value, pattern: "*" }
      if (key === "*" && value === "ask" && !(USER_CATCH_ALL in permission)) shippedCatchAll.add(rule)
      ruleset.push(rule)
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
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
