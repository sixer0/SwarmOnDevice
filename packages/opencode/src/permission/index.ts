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
import { Unattended } from "./unattended"

export const Event = PermissionV1.Event

export const MAX_SKIPPED = 20

/** The request an answer settled, with what that one answer also covers. Not public: `follows` never leaves the server. */
export type Answered = PermissionV1.Request & { follows?: PermissionV1.Follows }

export interface Grant extends Pick<PermissionV1.Request, "sessionID" | "permission" | "patterns"> {
  /** Came along with another request's answer, so nobody looked at this one by itself. A refusal still holds for it. */
  followed?: boolean
}

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  /** Returns the request when the agent had already carried on without it: the caller decides how to pick that back up. */
  readonly reply: (
    input: PermissionV1.ReplyInput,
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
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  grants: Grant[]
  /** Sessions whose last request went unanswered: nobody is there, so the next one is not worth a long wait. */
  away: Set<PermissionV1.Request["sessionID"]>
}

const sameRequest = (
  a: Pick<PermissionV1.Request, "sessionID" | "permission" | "patterns">,
  b: Pick<PermissionV1.Request, "sessionID" | "permission" | "patterns">,
) =>
  a.sessionID === b.sessionID &&
  a.permission === b.permission &&
  a.patterns.length === b.patterns.length &&
  a.patterns.every((pattern, index) => pattern === b.patterns[index])

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

/** Settles class P. A seam, so a test can count what reaches it. */
export class Decider extends Context.Service<
  Decider,
  {
    readonly decide: (input: PermissionV1.AskInput, root: SessionID, category?: string) => Effect.Effect<Decided>
  }
>()("@opencode/PermissionDecider") {}

const UNDECIDED: Decided = { decision: "defer", decidedBy: "system:decider_unavailable" }

const held = (category: AutonomyTable.HeldCategory): AutonomyTable.Verdict => ({
  class: "D",
  decidedBy: "gate",
  category,
})

const isHeldCategory = Schema.is(PermissionV1.DeferredCategory)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const decider = yield* Decider
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          grants: [],
          away: new Set(),
        } satisfies State as State

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

    const rootOf = (sessionID: SessionID): Effect.Effect<{ id: SessionID; directory?: string }> =>
      sessions.get(sessionID).pipe(
        Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session))),
        Effect.catchCause(() => Effect.succeed({ id: sessionID })),
      )

    /** What autonomous mode does with this request. Undefined when its root is not in the mode, and nothing changes then. */
    const gate = Effect.fn("Permission.gate")(function* (
      input: PermissionV1.AskInput,
      requestID: PermissionV1.ID,
      userCatchAll: boolean,
      // A person's answer to another request already covers this, so only a refusal is left to find.
      followed = false,
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
      if (followed && table.class !== "X") return undefined
      // Relative paths in a command mean nothing until its real folder is known, so no decider sees it without one.
      const placed = table.class === "P" && input.permission === "bash" && !cwd ? held("not_routine") : table
      const verdict = Autonomy.afterCheck(placed.class, check) === placed.class ? placed : held("not_routine")
      const decided =
        verdict.class === "P"
          ? yield* decider
              .decide(input, root.id, verdict.category)
              .pipe(Effect.catchCause(() => Effect.succeed(UNDECIDED)))
          : undefined
      const category =
        verdict.class === "P" && decided?.decision !== "allow" && decided?.decision !== "reject"
          ? ("decider_unavailable" as const)
          : verdict.category
      const decision =
        verdict.class === "P"
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

      // An ordinary edit never asks in any mode, and shows up as an edit. Everything else leaves a line.
      if (verdict.class === "A" && input.editClass === "ordinary") return { class: verdict.class, decision, category }
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
          class: verdict.class,
          category,
          risk: typeof input.metadata.risk === "string" ? input.metadata.risk : null,
          canUndo,
          decidedBy: decided?.decidedBy ?? (verdict.decidedBy === "person" ? "person" : "gate"),
          decision,
          reason: decided?.reason,
          memo: decided?.memo,
          latencyMs: decided?.latencyMs,
          costUsd: decided?.costUsd,
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
      // Nothing runs without a person unless the decision to let it is on record. Refusing or holding needs no such line.
      if (!written && decision === "allow")
        return { class: "D" as const, decision: "defer" as const, category: "not_routine" as const }
      return { class: verdict.class, decision, category }
    })

    const inMode = Effect.fnUntraced(function* (sessionID: SessionID) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(sessionID)
      return (yield* autonomy.check({ root: root.id, directory: root.directory ?? instance.directory })).on
    })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, away, grants, pending } = yield* InstanceState.get(state)
      const { ruleset, harmless, noAlways, follows, ...request } = input
      let needsAsk = false
      let userCatchAll = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, noAlways ? [] : approved)
        // Not the pattern: for a shell call it is the command, and that can hold a secret typed into its arguments.
        yield* Effect.logInfo("evaluated", { permission: request.permission, action: rule.action })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        // The shipped baseline asks about anything it does not name. That is for what could hurt, and this cannot.
        // A person who wrote "*": "ask" themselves meant every call, and that is not this rule.
        if (harmless && isShippedCatchAll(rule)) continue
        if (rule.permission === "*" && rule.pattern === "*" && !isShippedCatchAll(rule)) userCatchAll = true
        needsAsk = true
      }

      if (!needsAsk) return

      const granted = grants.findIndex((grant) => sameRequest(grant, request))
      const id = request.id ?? PermissionV1.ID.ascending()
      if (granted >= 0) {
        const [grant] = grants.splice(granted, 1)
        if (!grant?.followed) return
        // The person answered the prompt before this one, so what this one turned out to be was never in front of them.
        const gated = yield* gate(input, id, userCatchAll, true)
        if (gated?.class === "X") return yield* new RefusedByModeError({ ruleset: [] })
        return
      }
      // Already waiting for the user's decision on exactly this. Asking again would only add a wait and a second row.
      const waiting = [...pending.values()].find((item) => item.info.movedOnAt && sameRequest(item.info, request))
      if (waiting && !waiting.category) return yield* new PermissionV1.AwayError()
      // With the mode off the entry stays answerable, and this is a new request that gets an ordinary prompt.
      if (waiting?.category && (yield* inMode(request.sessionID)))
        return yield* new PermissionV1.DeferredError({ category: waiting.category })

      const gated = yield* gate(input, id, userCatchAll)
      if (gated?.decision === "allow") return
      // Refused by what it is, so no person is asked. Not a rejection: that error ends the run, and this one reports back.
      if (gated?.class === "X") return yield* new RefusedByModeError({ ruleset: [] })
      if (gated?.decision === "reject") return yield* new DeciderRefusedError({ ruleset: [] })

      // A repeating call stops the run on purpose until a person looks. Carrying on would defeat that guard.
      // The same goes for a spend limit: nobody being there is exactly when it must hold.
      const wait = needsPerson(request.permission) ? undefined : Unattended.wait(away.has(request.sessionID))
      const asked: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      const info: PermissionV1.Request = wait ? { ...asked, movesOnAt: Date.now() + wait } : asked
      yield* Effect.logInfo("asking", { id, permission: info.permission })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      // Held for the person with the agent already released, whatever the unattended wait is set to. An "always" on one
      // of these would open more than the single call anyone looked at, so it has nothing to apply to.
      if (gated?.decision === "defer") {
        const category = isHeldCategory(gated.category) ? gated.category : "not_routine"
        const moved: PermissionV1.Request = { ...asked, always: [], movedOnAt: Date.now(), deferred: true }
        pending.set(id, { info: moved, deferred, noAlways, follows, category })
        yield* Effect.logInfo("held", { id, permission: moved.permission, category })
        yield* events.publish(Event.Asked, moved)
        return yield* new PermissionV1.DeferredError({ category })
      }
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
        const skipped = [...pending.values()].filter(
          (item) => item.info.movedOnAt && item.info.sessionID === request.sessionID,
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

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, away, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      away.delete(existing.info.sessionID)
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
        return existing.follows ? { ...existing.info, follows: existing.follows } : existing.info
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
      grants.push({
        sessionID: input.sessionID,
        permission: input.permission,
        patterns: input.patterns,
        followed: input.followed,
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
