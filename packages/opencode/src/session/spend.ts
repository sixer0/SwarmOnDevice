import { Deferred, Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Permission } from "@/permission"
import type { Provider } from "@/provider/provider"
import type { Session } from "./session"
import type { MessageID, SessionID } from "./schema"

// A run is everything since the person's last message, across the session and all its subagents. It is what someone
// starting an agent and leaving is actually agreeing to, where a per-session total would trip again on every reply.
export const DEFAULT_LIMIT = 10

type Run = { from: MessageID; limit: number; stopped: boolean; asking?: Deferred.Deferred<void> }

// Session ids are unique across projects, so runs of different directories cannot collide. Entries stay small and few.
const runs = new Map<SessionID, Run>()

export const usd = (value: number) => `$${value.toFixed(2)}`

export const stopMessage = (limit: number) =>
  `Stopped here: this run reached its ${usd(limit)} spend limit. Nothing further was sent to the model. Send a message to continue.`

/** Whether a request to this model costs money. A model with no price, such as a self-hosted one, never does. */
export const isPaid = (model: Pick<Provider.Model, "cost">) => !!model.cost && model.cost.input + model.cost.output > 0

type Tree = { root: Session.Info; descendants: Session.Info[] }

const tree = Effect.fnUntraced(function* (sessions: Session.Interface, session: Session.Info) {
  // Always re-read: the caller holds the session as it was when the run began, whose cost is still what it was then.
  let root = yield* sessions.get(session.id).pipe(Effect.orDie)
  while (root.parentID) root = yield* sessions.get(root.parentID).pipe(Effect.orDie)
  const descendants: Session.Info[] = []
  const queue = [root.id]
  for (const parent of queue) {
    const children = yield* sessions.children(parent)
    descendants.push(...children)
    queue.push(...children.map((child) => child.id))
  }
  return { root, descendants } satisfies Tree
})

// An answer to something the agent skipped belongs to the run it came from: it is not someone agreeing to a new one.
const isPersonMessage = (message: SessionV1.WithParts) =>
  message.info.role === "user" &&
  !message.parts.some((part) => part.type === "compaction") &&
  message.parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored && !part.metadata?.lateAnswer)

/** What this run has cost so far, read from the database so a resumed run keeps counting from where it was. */
const measure = Effect.fnUntraced(function* (sessions: Session.Interface, input: Tree) {
  let own = 0
  let context = 0
  const found = yield* sessions
    .findMessage(input.root.id, (message) => {
      if (isPersonMessage(message)) return true
      if (message.info.role !== "assistant") return false
      own += message.info.cost
      const tokens = message.info.tokens
      context = Math.max(context, tokens.input + tokens.cache.read + tokens.cache.write)
      return false
    })
    .pipe(Effect.orDie)
  if (found._tag === "None") return undefined
  const since = found.value.info.time.created

  let subagents = 0
  let subagentCost = 0
  for (const child of input.descendants) {
    let cost = child.cost ?? 0
    // A subagent resumed from an earlier run brings its old total with it.
    if (child.time.created < since && cost > 0) {
      let recent = 0
      yield* sessions
        .findMessage(child.id, (message) => {
          if (message.info.time.created < since) return true
          if (message.info.role === "assistant") recent += message.info.cost
          return false
        })
        .pipe(Effect.orDie)
      cost = recent
    }
    if (cost > 0) subagents++
    subagentCost += cost
  }
  return { from: found.value.info.id, spent: own + subagentCost, context, subagents, subagentCost }
})

/**
 * Called before every model request of every session. Returns the limit that stopped the run, or undefined to go on.
 * Parallel subagents that reach the limit together share one question, asked on the session the person is looking at.
 * Only a request that would cost money can be held: an unpriced model carries on even if paid ones in the same run
 * have used up the limit, and since it adds nothing to the total, only money actually spent ever counts.
 */
export const check = Effect.fn("SessionSpend.check")(function* (input: {
  session: Session.Info
  sessions: Session.Interface
  permission: Permission.Interface
  model: Pick<Provider.Model, "cost">
  limit: number | undefined
}) {
  if (!isPaid(input.model)) return undefined
  const configured = input.limit ?? DEFAULT_LIMIT
  if (configured <= 0) return undefined
  while (true) {
    const family = yield* tree(input.sessions, input.session)
    const known = runs.get(family.root.id)
    // All-time totals are an upper bound, so the usual step costs a couple of indexed reads and no message loading.
    const ceiling = family.descendants.reduce((total, item) => total + (item.cost ?? 0), family.root.cost ?? 0)
    if (!known && ceiling < configured) return undefined

    const now = yield* measure(input.sessions, family)
    if (!now) return undefined
    const run: Run =
      known?.from === now.from ? known : { from: now.from, limit: configured, stopped: false }
    runs.set(family.root.id, run)
    if (run.stopped) return run.limit
    if (now.spent < run.limit) return undefined

    if (run.asking) {
      yield* Deferred.await(run.asking)
      continue
    }

    const asking = yield* Deferred.make<void>()
    run.asking = asking
    const next = now.spent + configured
    const answer = yield* input.permission
      .ask({
        permission: "spend_limit",
        // The readable amount, since every client that lists a request shows its patterns.
        patterns: [`${usd(now.spent)} of ${usd(run.limit)}`],
        sessionID: family.root.id,
        metadata: {
          spent: now.spent,
          limit: run.limit,
          next,
          context: now.context,
          subagents: now.subagents,
          subagentCost: now.subagentCost,
        },
        always: [],
        ruleset: [],
      })
      .pipe(
        Effect.as("continue" as const),
        Effect.catch(() => Effect.succeed("stop" as const)),
        Effect.ensuring(
          Effect.gen(function* () {
            run.asking = undefined
            yield* Deferred.succeed(asking, undefined)
          }),
        ),
      )
    if (answer === "stop") {
      run.stopped = true
      return run.limit
    }
    run.limit = next
  }
})

export * as SessionSpend from "./spend"
