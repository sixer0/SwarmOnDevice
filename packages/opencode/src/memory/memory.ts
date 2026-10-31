import { randomBytes, createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { MemoryLearn } from "./learn"

// One file per project under the user's data directory: never inside the repository, so it cannot be committed by
// accident, and shared by every worktree of a project. Plain JSON the user can read, and mode 0600.

export const Item = ProjectMemory.Item
export type Item = ProjectMemory.Item
export const Info = ProjectMemory.Info
export type Info = ProjectMemory.Info
export const Result = ProjectMemory.Result
export type Result = ProjectMemory.Result
export const Event = ProjectMemory.Event

export const MAX_ITEMS = 40
export const MAX_TEXT = 400

const disabled = () => !!process.env.SWARM_DISABLE_MEMORY

type Stored = { version: 1; enabled: boolean; items: Item[] }
type Failure = { command: string; where: string }

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly add: (input: {
    text: string
    source: Item["source"]
    deviceOnly?: boolean
    sessionID?: string
  }) => Effect.Effect<Result>
  readonly update: (id: string, input: { text?: string; deviceOnly?: boolean }) => Effect.Effect<Result>
  readonly remove: (id: string) => Effect.Effect<boolean>
  readonly setEnabled: (enabled: boolean) => Effect.Effect<Info>
  /** The text for this model's system prompt. Notes kept on this device are left out for a model that is not. */
  readonly prompt: (model: Provider.Model) => Effect.Effect<string | undefined>
  readonly onDevice: (model: Provider.Model) => Effect.Effect<boolean>
  /** Watches what the shell tool ran and turns "that failed to start, this worked" into a note. */
  readonly observeCommand: (input: {
    sessionID: string
    command: string
    workdir?: string
    exit: number | null | undefined
    output: string
    model: Provider.Model
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectMemory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const provider = yield* Provider.Service
    // Only the failures of runs in progress, so restarting forgets a half-finished observation and nothing else.
    const failures = new Map<string, Map<string, Failure>>()

    const file = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      // Every folder without git shares the "global" project, and their notes must not mix.
      const key =
        ctx.project.id === "global"
          ? "dir-" + createHash("sha256").update(ctx.directory).digest("hex").slice(0, 24)
          : String(ctx.project.id)
      return path.join(Global.Path.data, "memory", `${key}.json`)
    })

    const read = (target: string) => Effect.promise(() => readStore(target))

    /** Serialised across processes: several Swarm processes can run agents on one project. */
    const change = <A>(target: string, fn: (store: Stored) => { store?: Stored; value: A }) =>
      Effect.promise(() =>
        Flock.withLock(`memory:${path.basename(target)}`, async () => {
          const result = fn(await readStore(target))
          if (result.store) await writeStore(target, result.store)
          return result.value
        }),
      )

    const publish = (added?: Item) => events.publish(Event.Updated, { added })

    const add: Interface["add"] = Effect.fn("ProjectMemory.add")(function* (input) {
      const text = input.text.replace(/\s+/g, " ").trim()
      const refused = refusal(text)
      if (refused) return { refused }
      const target = yield* file()
      const result = yield* change(target, (store): { store?: Stored; value: { result: Result; fresh: boolean } } => {
        const same = store.items.find((item) => item.text.toLowerCase() === text.toLowerCase())
        if (same) return { value: { result: { item: same }, fresh: false } }
        const room = makeRoom(store.items)
        if (!room) return { value: { result: { refused: "full" }, fresh: false } }
        const item: Item = {
          id: randomBytes(3).toString("hex"),
          text,
          source: input.source,
          deviceOnly: input.deviceOnly ?? false,
          time: Date.now(),
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        }
        return { store: { ...store, items: [...room, item] }, value: { result: { item }, fresh: true } }
      })
      if (result.fresh) yield* publish(input.source === "user" ? undefined : result.result.item)
      return result.result
    })

    const addLesson = Effect.fnUntraced(function* (item: {
      text: string
      deviceOnly: boolean
      sessionID: string
      failed: string
      worked: string
    }) {
      const target = yield* file()
      const added = yield* change(target, (store): { store?: Stored; value: Item | undefined } => {
        // A repeated lesson about the same failing command is the same lesson, whatever worked this time.
        if (store.items.some((existing) => existing.failed === item.failed)) return { value: undefined }
        const room = makeRoom(store.items)
        if (!room) return { value: undefined }
        const next: Item = { id: randomBytes(3).toString("hex"), source: "learned", time: Date.now(), ...item }
        return { store: { ...store, items: [...room, next] }, value: next }
      })
      if (added) yield* publish(added)
    })

    /** A lesson that stopped being true removes itself, so the list does not rot into wrong advice. */
    const dropStale = Effect.fnUntraced(function* (match: (item: Item) => boolean) {
      const target = yield* file()
      const dropped = yield* change(target, (store) => {
        const items = store.items.filter((item) => !match(item))
        return items.length === store.items.length ? { value: false } : { store: { ...store, items }, value: true }
      })
      if (dropped) yield* publish(undefined)
    })

    const onDevice: Interface["onDevice"] = Effect.fn("ProjectMemory.onDevice")(function* (model) {
      // options.baseURL overrides the catalog URL when the request is built (Provider.getLanguage).
      const info = yield* provider.getProvider(model.providerID).pipe(Effect.option)
      const configured = info._tag === "Some" ? info.value.options["baseURL"] : undefined
      return MemoryLearn.isOnDeviceURL(typeof configured === "string" && configured ? configured : model.api.url)
    })

    return Service.of({
      get: Effect.fn("ProjectMemory.get")(function* () {
        const store = yield* read(yield* file())
        return { enabled: store.enabled, items: store.items }
      }),
      add,
      update: Effect.fn("ProjectMemory.update")(function* (id, input) {
        const text = input.text === undefined ? undefined : input.text.replace(/\s+/g, " ").trim()
        const refused = text === undefined ? undefined : refusal(text)
        if (refused) return { refused }
        const target = yield* file()
        const item = yield* change(target, (store) => {
          const found = store.items.find((item) => item.id === id)
          if (!found) return { value: undefined }
          // Rewritten by the user, it is their note now and no longer ties to a command the runtime may retract.
          const next: Item =
            text !== undefined && text !== found.text
              ? { ...found, text, source: "user", failed: undefined, worked: undefined }
              : found
          const value = input.deviceOnly === undefined ? next : { ...next, deviceOnly: input.deviceOnly }
          return { store: { ...store, items: store.items.map((item) => (item.id === id ? value : item)) }, value }
        })
        if (item) yield* publish(undefined)
        return item ? { item } : {}
      }),
      remove: Effect.fn("ProjectMemory.remove")(function* (id) {
        const target = yield* file()
        const removed = yield* change(target, (store) => {
          const items = store.items.filter((item) => item.id !== id)
          return items.length === store.items.length ? { value: false } : { store: { ...store, items }, value: true }
        })
        if (removed) yield* publish(undefined)
        return removed
      }),
      setEnabled: Effect.fn("ProjectMemory.setEnabled")(function* (enabled) {
        const target = yield* file()
        const info = yield* change(target, (store) => {
          const next = { ...store, enabled }
          return { store: next, value: { enabled, items: next.items } }
        })
        yield* publish(undefined)
        return info
      }),
      prompt: Effect.fn("ProjectMemory.prompt")(function* (model) {
        if (disabled()) return undefined
        const store = yield* read(yield* file())
        if (!store.enabled) return undefined
        const local = yield* onDevice(model)
        return MemoryLearn.promptBlock(store.items.filter((item) => local || !item.deviceOnly))
      }),
      onDevice,
      observeCommand: Effect.fn("ProjectMemory.observeCommand")(function* (input) {
        if (disabled()) return
        const ctx = yield* InstanceState.context
        const parsed = MemoryLearn.parseCommand({
          command: input.command,
          workdir: input.workdir,
          directory: ctx.directory,
          worktree: ctx.worktree,
        })
        if (!parsed) return
        const intent = MemoryLearn.intentOf(parsed.command)
        if (!intent) return
        const key = MemoryLearn.commandKey(parsed)
        if (MemoryLearn.invocationFailure(input.exit, input.output)) {
          if (failures.size > 64) failures.clear()
          const session = failures.get(input.sessionID) ?? new Map<string, Failure>()
          failures.set(input.sessionID, session.set(intent, parsed))
          yield* dropStale((item) => item.worked === key)
          return
        }
        if (input.exit !== 0) return
        yield* dropStale((item) => item.failed === key)
        const failure = failures.get(input.sessionID)?.get(intent)
        if (!failure || MemoryLearn.commandKey(failure) === key) return
        failures.get(input.sessionID)?.delete(intent)
        const store = yield* read(yield* file())
        if (!store.enabled) return
        yield* addLesson({
          text: MemoryLearn.lessonText({ failed: failure, worked: parsed }),
          deviceOnly: yield* onDevice(input.model),
          sessionID: input.sessionID,
          failed: MemoryLearn.commandKey(failure),
          worked: key,
        })
      }),
    })
  }),
)

function refusal(text: string): ProjectMemory.Refusal | undefined {
  if (!text) return "empty"
  if (text.length > MAX_TEXT) return "long"
  if (MemoryLearn.looksSecret(text)) return "secret"
}

/** Room for one more, or undefined when full of notes somebody chose to keep: only learned lessons are evicted. */
function makeRoom(items: readonly Item[]) {
  if (items.length < MAX_ITEMS) return [...items]
  const oldest = items.find((item) => item.source === "learned")
  return oldest ? items.filter((item) => item !== oldest) : undefined
}

const decodeStore = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ enabled: Schema.optional(Schema.Boolean), items: Schema.Array(Item) })),
)

async function readStore(target: string): Promise<Stored> {
  const text = await fs.readFile(target, "utf8").catch(() => undefined)
  if (text === undefined) return { version: 1, enabled: true, items: [] }
  const parsed = decodeStore(text)
  if (parsed._tag === "Some")
    return { version: 1, enabled: parsed.value.enabled !== false, items: [...parsed.value.items] }
  // A file somebody edited badly must not be overwritten by the next note.
  await fs.copyFile(target, `${target}.unreadable`).catch(() => undefined)
  return { version: 1, enabled: true, items: [] }
}

async function writeStore(target: string, store: Stored) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temporary, target)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Provider.node],
})

export * as Memory from "./memory"
