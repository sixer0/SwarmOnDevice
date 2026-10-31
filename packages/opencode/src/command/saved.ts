import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import matter from "gray-matter"
import { LLMEvent } from "@opencode-ai/llm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { Flock } from "@opencode-ai/core/util/flock"
import { jobMatchesLabel, sameJob } from "@opencode-ai/core/util/same-job"
import { SavedCommand as Schemas } from "@opencode-ai/schema/saved-command"
import { Agent } from "@/agent/agent"
import { ConfigCommand } from "@/config/command"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MemoryLearn } from "@/memory/learn"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"
import { Command } from "./index"
import PROMPT from "./saved-draft.txt"
import { SavedCommandModel as Model } from "./saved-model"

// Saved commands are ordinary command files, so they work in the terminal UI and the CLI, and can be committed. Nobody
// has to know that: this service is the part that writes them, from a finished run.

export const Item = Schemas.Item
export type Item = Schemas.Item
export const Draft = Schemas.Draft
export type Draft = Schemas.Draft
export const Result = Schemas.Result
export type Result = Schemas.Result
export const Repeat = Schemas.Repeat
export type Repeat = Schemas.Repeat
export const Event = Schemas.Event

/** A job is mentioned the third time it is asked for: once could be anything and twice could be a retry. */
export const REPEAT_AT = 3
const LOOK_BACK = 80
const MAX_HANDLED = 60
const DRAFT_TIMEOUT = Duration.seconds(60)
/** Names the app and terminal UI answer themselves, which would hide a saved command of the same name. */
const RESERVED = new Set(
  "new undo redo memory compact fork export open terminal mcp model agent workspace save help exit quit session sessions theme themes editor share unshare fleet connect models agents status".split(
    " ",
  ),
)

export interface Interface {
  readonly list: () => Effect.Effect<Item[]>
  /** Works out a command from a run, using only the model that run already used. Never fails: see Model.fallbackDraft. */
  readonly draft: (sessionID: SessionID) => Effect.Effect<Draft, Session.NotFound>
  readonly save: (input: {
    name: string
    description?: string
    template: string
    global?: boolean
    /** The name of the command being edited. Anything else that already exists is refused rather than overwritten. */
    replaces?: string
    sessionID?: SessionID
  }) => Effect.Effect<Result>
  readonly remove: (name: string) => Effect.Effect<boolean>
  /** How often this run's job has been asked for here. 0 unless it is worth a line. */
  readonly repeat: (sessionID: SessionID) => Effect.Effect<Repeat>
  /** The person said no, so this job is not offered again. */
  readonly decline: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SavedCommand") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const commands = yield* Command.Service
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const { db } = yield* Database.Service

    const handledFile = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const key =
        ctx.project.id === "global"
          ? "dir-" + createHash("sha256").update(ctx.directory).digest("hex").slice(0, 24)
          : String(ctx.project.id)
      return path.join(Global.Path.data, "saved-commands", `${key}.json`)
    })

    const addHandled = Effect.fnUntraced(function* (prompt: string | undefined) {
      if (!prompt) return
      const target = yield* handledFile()
      yield* Effect.promise(() =>
        Flock.withLock(`saved-commands:${path.basename(target)}`, async () => {
          const handled = await readHandled(target)
          await writeHandled(target, [...handled, prompt.slice(0, 400)].slice(-MAX_HANDLED))
        }),
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("could not record handled job", { cause })))
    })

    // The text of each session's first user message. Messages are far fewer than parts, so the parts are only read for
    // the one message per session that matters: this runs each time a run settles, against every recent session.
    const firstPrompts = Effect.fnUntraced(function* (ids: readonly SessionID[]) {
      if (ids.length === 0) return new Map<string, string>()
      const messages = yield* db
        .select({ id: MessageTable.id, session: MessageTable.session_id })
        .from(MessageTable)
        .where(and(inArray(MessageTable.session_id, [...ids]), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`))
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const firstMessage = new Map<string, MessageID>()
      for (const message of messages) {
        if (!firstMessage.has(message.session)) firstMessage.set(message.session, message.id)
      }
      if (firstMessage.size === 0) return new Map<string, string>()
      const parts = yield* db
        .select({ session: PartTable.session_id, data: PartTable.data })
        .from(PartTable)
        .where(inArray(PartTable.message_id, [...firstMessage.values()]))
        .orderBy(asc(PartTable.id))
        .all()
        .pipe(Effect.orDie)
      const first = new Map<string, string>()
      for (const part of parts) {
        if (first.has(part.session)) continue
        const text = Model.askedText(part.data as Parameters<typeof Model.askedText>[0])
        if (text) first.set(part.session, text)
      }
      return first
    })

    const scoped = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const project = Flag.OPENCODE_DISABLE_PROJECT_CONFIG ? undefined : Command.projectDir(ctx)
      return { global: Global.Path.config, project }
    })

    const list: Interface["list"] = Effect.fn("SavedCommand.list")(function* () {
      const dirs = yield* scoped()
      const load = (dir: string | undefined) =>
        dir ? Effect.promise(() => ConfigCommand.load(dir).catch(() => ({}))) : Effect.succeed({})
      const items = new Map<string, Item>()
      const add = (found: Awaited<ReturnType<typeof ConfigCommand.load>>, scope: Item["scope"]) => {
        for (const [name, command] of Object.entries(found)) {
          items.set(name, { name, description: command.description, template: command.template, scope })
        }
      }
      add(yield* load(dirs.global), "global")
      add(yield* load(dirs.project), "project")
      return [...items.values()].sort((a, b) => a.name.localeCompare(b.name))
    })

    const takenBySomethingElse = Effect.fnUntraced(function* (name: string) {
      if (RESERVED.has(name) || name === Command.Default.INIT || name === Command.Default.REVIEW) return true
      const known = yield* commands.get(name)
      return !!known && known.source !== "command"
    })

    const draft: Interface["draft"] = Effect.fn("SavedCommand.draft")(function* (sessionID) {
      yield* sessions.get(sessionID)
      const ctx = yield* InstanceState.context
      const messages = yield* sessions.messages({ sessionID })
      const record = Model.digest(messages, ctx.directory)
      const written = yield* write(record, messages, sessionID)
      const saved = new Set((yield* commands.list()).map((command) => command.name))
      const base = written ?? Model.fallbackDraft(record)
      return {
        name: Model.freeName(base.name, (name) => saved.has(name) || RESERVED.has(name)),
        description: base.description,
        template: base.template,
        source: written ? ("model" as const) : ("prompts" as const),
      }
    })

    // The run's own model and no other: the small model could be off-device when the run was on it.
    const write = Effect.fnUntraced(function* (
      record: Model.Digest,
      messages: readonly Parameters<typeof Model.digest>[0][number][],
      sessionID: SessionID,
    ) {
      const lastUser = messages.findLast((message) => message.info.role === "user")?.info
      if (!lastUser || lastUser.role !== "user" || record.prompts.length === 0) return undefined
      const base = yield* agents.get("title")
      if (!base) return undefined
      const model = yield* provider.getModel(lastUser.model.providerID, lastUser.model.modelID)
      const text = yield* llm
        .stream({
          agent: { ...base, prompt: PROMPT },
          user: lastUser,
          system: [],
          small: true,
          tools: {},
          model,
          sessionID,
          retries: 1,
          messages: [{ role: "user", content: `<session>\n${Model.digestText(record)}\n</session>` }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
          Effect.timeoutOption(DRAFT_TIMEOUT),
          Effect.map(Option.getOrUndefined),
        )
      return text ? Model.parseDraft(text) : undefined
    }, (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("saved command draft fell back to the run's record", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(undefined),
          ),
        ),
      ),
    )

    const fileOf = (dir: string, name: string) =>
      Effect.promise(async () => {
        for (const folder of ["command", "commands"]) {
          const file = path.join(dir, folder, `${name}.md`)
          if (await fs.stat(file).then(() => true, () => false)) return file
        }
        return undefined
      })

    const save: Interface["save"] = Effect.fn("SavedCommand.save")(function* (input) {
      const name = input.name.trim()
      const template = input.template.trim()
      const description = input.description?.trim().replace(/\s+/g, " ")
      if (!Model.validName(name)) return { refused: "name" as const }
      if (!template) return { refused: "empty" as const }
      if (template.length > Model.MAX_TEMPLATE) return { refused: "long" as const }
      if (MemoryLearn.looksSecret(template) || (description && MemoryLearn.looksSecret(description))) {
        return { refused: "secret" as const }
      }
      if (yield* takenBySomethingElse(name)) return { refused: "taken" as const }

      const dirs = yield* scoped()
      const dir = input.global || !dirs.project ? dirs.global : dirs.project
      const other = dir === dirs.global ? dirs.project : dirs.global
      const existing = yield* fileOf(dir, name)
      const elsewhere = other ? yield* fileOf(other, name) : undefined
      if ((existing || elsewhere) && input.replaces !== name) return { refused: "taken" as const }

      const file = existing ?? path.join(dir, "command", `${name}.md`)
      yield* Effect.promise(async () => {
        // A command somebody wrote by hand may set a model or an agent. Editing its words must not lose those.
        const kept = existing ? matter(await fs.readFile(existing, "utf8")).data : {}
        const { description: _, ...rest } = kept as Record<string, unknown>
        const data = description ? { description, ...rest } : rest
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, matter.stringify(`\n${template}\n`, data))
        // Moving a command between "this project" and "all projects" leaves one copy, not two.
        if (elsewhere) await fs.rm(elsewhere, { force: true })
      })

      if (input.sessionID) {
        const prompts = yield* firstPrompts([input.sessionID])
        yield* addHandled(prompts.get(input.sessionID))
      }
      yield* events.publish(Event.Updated, {})
      return {
        item: {
          name,
          description: description || undefined,
          template,
          scope: dir === dirs.global ? ("global" as const) : ("project" as const),
        },
      }
    })

    const remove: Interface["remove"] = Effect.fn("SavedCommand.remove")(function* (name) {
      // Only a name that came from listing the folders is ever joined into a path.
      if (!(yield* list()).some((item) => item.name === name)) return false
      const dirs = yield* scoped()
      let removed = false
      for (const dir of [dirs.project, dirs.global]) {
        if (!dir) continue
        const file = yield* fileOf(dir, name)
        if (!file) continue
        yield* Effect.promise(() => fs.rm(file, { force: true }))
        removed = true
      }
      if (removed) yield* events.publish(Event.Updated, {})
      return removed
    })

    const repeat: Interface["repeat"] = Effect.fn("SavedCommand.repeat")(function* (sessionID) {
      const nothing = { times: 0 }
      const session = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!session || session.parentID) return nothing
      const recent = yield* sessions.list({ roots: true, scope: "project", limit: LOOK_BACK })
      const prompts = yield* firstPrompts([...new Set([sessionID, ...recent.map((item) => item.id)])])
      const asked = prompts.get(sessionID)
      if (!asked) return nothing
      const others = recent.filter((item) => item.id !== sessionID && !item.time.archived)
      const earlier = others.filter((item) => {
        const prompt = prompts.get(item.id)
        return !!prompt && sameJob(asked, prompt)
      })
      if (earlier.length + 1 < REPEAT_AT) return nothing

      const handled = yield* handledFile().pipe(Effect.flatMap((file) => Effect.promise(() => readHandled(file))))
      if (handled.some((prompt) => sameJob(asked, prompt))) return nothing
      const saved = yield* list()
      const covered = saved.some(
        (item) =>
          // A run started from a command begins with that command's text.
          sameJob(asked, item.template) || jobMatchesLabel(asked, item.description || item.name.replaceAll("-", " ")),
      )
      return covered ? nothing : { times: earlier.length + 1 }
    })

    const decline: Interface["decline"] = Effect.fn("SavedCommand.decline")(function* (sessionID) {
      const prompts = yield* firstPrompts([sessionID])
      yield* addHandled(prompts.get(sessionID))
    })

    return Service.of({ list, draft, save, remove, repeat, decline })
  }),
)

const decodeHandled = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

async function readHandled(target: string): Promise<readonly string[]> {
  const text = await fs.readFile(target, "utf8").catch(() => undefined)
  if (text === undefined) return []
  const parsed = decodeHandled(text)
  return parsed._tag === "Some" ? parsed.value : []
}

async function writeHandled(target: string, handled: readonly string[]) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(handled, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temporary, target)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Command.node,
    EventV2Bridge.node,
    Session.node,
    Agent.node,
    Provider.node,
    LLM.node,
    Database.node,
  ],
})

export * as SavedCommands from "./saved"
