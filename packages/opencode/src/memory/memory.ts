import { randomBytes, createHash } from "node:crypto"
import { constants as fsConstants, createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { MemoryLearn } from "./learn"
import { VaultMirror } from "./vault-mirror"

// One file per project under the user's data directory: never inside the repository, so it cannot be committed by
// accident, and shared by every worktree of a project. Plain JSON the user can read, and mode 0600.

export const Item = ProjectMemory.Item
export type Item = ProjectMemory.Item
export const Info = ProjectMemory.Info
export type Info = ProjectMemory.Info
export const Result = ProjectMemory.Result
export type Result = ProjectMemory.Result
export const Event = ProjectMemory.Event

export type MemoryRef = ProjectMemory.MemoryRef

// The limits come from the schema (ProjectMemory.LIMITS, 1.2.6 M1 S6), which the app's memory view reads too.
/** The note line (hook), always indexed and eligible for the prompt. A longer line is refused, never cut (U11). */
export const MAX_TEXT = ProjectMemory.LIMITS.text
/** The optional body: returned by recall, never put in the prompt. */
export const MAX_BODY = ProjectMemory.LIMITS.body
/** References per note, counted after exact duplicates are removed. */
export const MAX_REFS = ProjectMemory.LIMITS.refs
/** Notes per store at which consolidation runs, then again after every further 100 (C6). Not a cap: nothing is refused. */
export const CONSOLIDATE_AT = 1000
/** Estimated tokens for the whole `<project_memory>` block (U18). Used by the prompt loader. */
export const LOAD_BUDGET_TOKENS = 8000

/**
 * The Studio mission id pattern (`MISSION_ID_PATTERN`, datum-studio `src/mcp-host/mission/schemas.ts`), copied as a
 * literal because opencode does not depend on datum-studio; a test pins the two equal (01e §2.1).
 */
export const MISSION_ID_PATTERN = "^\\d{4}-\\d{2}-\\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$"
const MISSION_ID = new RegExp(MISSION_ID_PATTERN)

/**
 * The period a roll-up of index entries covers (N8-011). The year is the second level: quarterly roll-ups of one year
 * roll into a yearly one when the index is still full (01e §5.2).
 */
export const INDEX_ROLLUP_PERIOD = "quarter"

/**
 * The memory store key of a project folder (N8-446, 01d §2.2): the store file is `<data>/memory/<key>.json`. Every folder
 * without git shares the "global" project, and their notes must not mix, so such a folder gets `dir-<sha256>` of its
 * path. The re-home primitive (`Rehome`, N8-132) computes both stores of a move with this same function.
 */
export function storeKey(projectId: string, directory: string) {
  return projectId === "global"
    ? "dir-" + createHash("sha256").update(directory).digest("hex").slice(0, 24)
    : String(projectId)
}

const CONSOLIDATE_STEP = 100
const VERSION = 2

const disabled = () => !!process.env.SWARM_DISABLE_MEMORY

type Consolidated = { count: number; time: number }
type Stored = { version: number; enabled: boolean; items: Item[]; consolidated?: Consolidated }
type Failure = { command: string; where: string }

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly add: (input: {
    text: string
    source: Item["source"]
    deviceOnly?: boolean
    sessionID?: string
    /** Detail kept with the note, up to MAX_BODY characters, line breaks kept. */
    body?: string
    /** Files or graft symbols the note points at, up to MAX_REFS. Stored, never their content. */
    refs?: readonly MemoryRef[]
    /** The writing session had consumed web, MCP, Studio data or files outside the worktree (SEC-09). */
    untrusted?: boolean
    /**
     * "index": a mission index entry (1.2.8 F-MEM). The line must follow ProjectMemory.INDEX_TEXT_PATTERN; one entry
     * per mission, a second write replaces the first. Any other value is refused `index_format`.
     */
    kind?: string
    /** Required with kind "index": the mission id, equal to the id in the line. */
    missionId?: string
  }) => Effect.Effect<Result>
  readonly update: (id: string, input: { text?: string; deviceOnly?: boolean }) => Effect.Effect<Result>
  readonly remove: (id: string) => Effect.Effect<boolean>
  readonly setEnabled: (enabled: boolean) => Effect.Effect<Info>
  /**
   * The text for this model's system prompt: the best-ranked notes within LOAD_BUDGET_TOKENS. Notes kept on this device
   * are left out for a model that is not. With `focus`, the ranking follows the session's first message and folder,
   * fixed at the session's first call, and the block stays byte-identical while the store is unchanged (prompt cache).
   */
  readonly prompt: (
    model: Provider.Model,
    focus?: { sessionID: string; query: string; directory: string },
  ) => Effect.Effect<string | undefined>
  /**
   * A note id (hook, body, references checked now) or words to search for. The same eligibility as the prompt: nothing
   * while memory is off, no device-only note for a model off this device, no note that looks like a secret. Writes
   * nothing. Undefined when memory is off.
   */
  readonly recall: (input: { query: string; model?: Provider.Model }) => Effect.Effect<string | undefined>
  readonly onDevice: (model: Provider.Model) => Effect.Effect<boolean>
  /**
   * OBS-d (01c §5): refresh this project's vault mirror in the background, now (`immediate`, T2/T3) or debounced
   * (`VaultMirror.MIRROR_DEBOUNCE_MS`). Never fails and never waits for the run; nothing runs while memory is off.
   */
  readonly mirror: (options?: { immediate?: boolean }) => Effect.Effect<void>
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
    // Per session: the focus fixed at its first prompt, and the last block with the store state it was built from.
    const sessions = new Map<string, { focus: MemoryLearn.Focus; key?: string; block?: string }>()

    const file = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return path.join(Global.Path.data, "memory", `${storeKey(ctx.project.id, ctx.directory)}.json`)
    })

    const read = (target: string) => Effect.promise(() => readStore(target))

    /** Where relative ref paths start: the worktree, or the folder itself for a project without git. */
    const root = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return ctx.worktree === "/" ? ctx.directory : ctx.worktree
    })

    /** Serialised across processes: several Swarm processes can run agents on one project. */
    const change = <A>(target: string, fn: (store: Stored) => { store?: Stored; value: A }) =>
      Effect.promise(() =>
        Flock.withLock(`memory:${path.basename(target)}`, async () => {
          const before = await readStore(target)
          const result = fn(before)
          if (result.store) await writeStore(target, result.store, before.version)
          return result.value
        }),
      )

    /**
     * OBS-d (01c §5). The job reads the store fresh when it runs, so a debounced run sees the last write of a burst.
     * Refusals of the writer are logged as warnings, any failure as an error: the memory write has already succeeded and
     * a close is never blocked. Nothing is scheduled while memory is off; a disabled store makes the run a no-op.
     */
    const refresh = (options: { immediate?: boolean; backfill?: boolean }) =>
      Effect.gen(function* () {
        if (disabled()) return
        const ctx = yield* InstanceState.context
        const key = storeKey(ctx.project.id, ctx.directory)
        const target = path.join(Global.Path.data, "memory", `${key}.json`)
        const directory = ctx.directory
        const projectRoot = ctx.worktree === "/" ? ctx.directory : ctx.worktree
        const bridge = yield* EffectBridge.make()
        const run = Effect.gen(function* () {
          if (disabled()) return undefined
          const store = yield* read(target)
          if (!store.enabled) return undefined
          const refusals: { code: VaultMirror.SyncCode; path: string; reason: string }[] = []
          const result = yield* Effect.promise(async () =>
            VaultMirror.sync({
              key,
              directory,
              projectRoot,
              items: store.items,
              enabled: store.enabled,
              language: await VaultMirror.labelLanguage(directory, key),
              log: (entry) => refusals.push(entry),
            }),
          )
          for (const entry of refusals)
            yield* Effect.logWarning("vault mirror refused a path", {
              source: "ProjectMemory.mirror",
              store: key,
              code: entry.code,
              // G2-02 (row 43f): the sync hands a vault-relative path and a reason without paths; never the home folder.
              path: entry.path,
              reason: entry.reason,
            })
          return result
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("vault mirror failed", {
              source: "ProjectMemory.mirror",
              store: key,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(undefined)),
          ),
        )
        const job = () => bridge.promise(run)
        if (!options.backfill) return VaultMirror.schedule(key, job, { immediate: options.immediate })
        // T4: checked in the background, so the prompt never waits for the disk.
        void VaultMirror.backfillDue(directory, key).then(
          (due) => (due ? VaultMirror.schedule(key, job) : undefined),
          () => undefined,
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("vault mirror not scheduled", { source: "ProjectMemory.mirror", cause: Cause.pretty(cause) }),
        ),
      )

    const mirror: Interface["mirror"] = (options) => refresh({ immediate: options?.immediate })
    // T4: stores whose first prompt in this process has been seen.
    const prompted = new Set<string>()

    /** Every store write is announced here, so it is also where the mirror is refreshed (T1, debounced). */
    const publish = (added?: Item) =>
      events.publish(Event.Updated, { added }).pipe(Effect.andThen(mirror()))

    /**
     * Cleanup once a store is large (C6): merges duplicates and drops references whose target is gone. It never refuses
     * anything and never fails the note that triggered it. Refs are checked outside the lock (I/O); the result is applied
     * under the lock only to notes that are unchanged since they were read.
     */
    const consolidateRun = Effect.fnUntraced(function* (target: string) {
      const store = yield* read(target)
      if (!consolidationDue(store)) return
      const resolver = refResolver(yield* root())
      const stale = yield* Effect.promise(() => staleRefs(store.items, resolver))
      const snapshot = new Map(store.items.map((item) => [item.id, JSON.stringify(item)]))
      const changed = yield* change(target, (current) => {
        if (!consolidationDue(current)) return { value: false }
        const next = consolidate(current.items, { stale: (ref) => stale.has(refKey(ref)), snapshot })
        return {
          store: { ...current, items: next.items, consolidated: { count: next.items.length, time: Date.now() } },
          value: next.changed,
        }
      })
      if (changed) yield* publish(undefined)
    })
    const consolidateIfDue = (target: string) =>
      consolidateRun(target).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("memory consolidation failed", {
            source: "ProjectMemory.consolidate",
            store: path.basename(target),
            cause: Cause.pretty(cause),
          }),
        ),
      )

    /**
     * A mission index entry (01e §2.2-2.3). Checked whole before anything is written; the report path is added as the
     * first ref. A second entry for the same mission replaces the first in place (same id, `rolledInto` kept), even when
     * it is archived; the "same text" shortcut of ordinary notes does not apply.
     */
    const addIndex = Effect.fnUntraced(function* (
      input: Parameters<Interface["add"]>[0],
      text: string,
      body: string | undefined,
      given: MemoryRef[],
    ) {
      const missionId = input.missionId ?? ""
      const checked = indexRefusal({ text, missionId, kind: input.kind })
      if (typeof checked === "string") return { refused: checked } satisfies Result
      const refs = uniqueRefs([{ path: checked.report }, ...given])
      const refused = refusal({ text, body, refs, index: true })
      if (refused) return { refused } satisfies Result
      const target = yield* file()
      type Outcome = { item: Item; fresh: boolean } | { refused: ProjectMemory.Refusal }
      const result = yield* change(target, (store): { store?: Stored; value: Outcome } => {
        const found = store.items.find((item) => isIndex(item) && item.missionId === missionId)
        const used = new Set(store.items.map((item) => item.id))
        const freshId = () => {
          const id = randomBytes(3).toString("hex")
          if (used.has(id)) return freshId()
          used.add(id)
          return id
        }
        const time = Date.now()
        // A new entry that would make the live index 41 rolls older entries up first, in this same lock (01e §2.3).
        // A replacement adds nothing and rolls nothing.
        const rolled =
          !found && store.items.filter(liveIndex).length >= ProjectMemory.INDEX_LIMITS.entries
            ? rollUp(store.items, { date: checked.date, time, id: freshId })
            : { items: store.items }
        if ("refused" in rolled) return { value: rolled }
        const item: Item = {
          id: found ? found.id : freshId(),
          text,
          source: input.source,
          deviceOnly: (found?.deviceOnly ?? false) || (input.deviceOnly ?? false),
          time,
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
          ...(body ? { body } : {}),
          refs,
          ...(input.untrusted ? { untrusted: true } : {}),
          kind: "index",
          missionId,
          ...(found?.rolledInto ? { rolledInto: found.rolledInto } : {}),
        }
        const items = found
          ? store.items.map((existing) => (existing.id === found.id ? item : existing))
          : [...rolled.items, item]
        return { store: { ...store, items }, value: { item, fresh: !found } }
      })
      // index_full: the store is unchanged, nothing was cut (R20-C03).
      if ("refused" in result) return { refused: result.refused } satisfies Result
      // A replacement is no new note: no toast. A new entry announces itself like any agent note; the roll-up is silent.
      yield* publish(result.fresh && input.source !== "user" ? result.item : undefined)
      // T2 (01c §5): the report was written before its index entry (MEM-f), so the mirror copies it now, no debounce.
      yield* mirror({ immediate: true })
      return { item: result.item } satisfies Result
    })

    const add: Interface["add"] = Effect.fn("ProjectMemory.add")(function* (input) {
      const text = input.text.replace(/\s+/g, " ").trim()
      const body = input.body?.trimEnd() || undefined
      const base = yield* root()
      const refs = uniqueRefs((input.refs ?? []).map((ref) => normaliseRef(ref, base)))
      if (input.kind !== undefined) {
        if (!text) return { refused: "empty" }
        return yield* addIndex(input, text, body, refs)
      }
      const refused = refusal({ text, body, refs })
      if (refused) return { refused }
      const target = yield* file()
      const result = yield* change(target, (store): { store?: Stored; value: { result: Result; fresh: boolean } } => {
        const same = store.items.find(
          (item) => item.kind === undefined && item.text.toLowerCase() === text.toLowerCase(),
        )
        if (same) return { value: { result: { item: same }, fresh: false } }
        const item: Item = {
          id: randomBytes(3).toString("hex"),
          text,
          source: input.source,
          deviceOnly: input.deviceOnly ?? false,
          time: Date.now(),
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
          ...(body ? { body } : {}),
          ...(refs.length ? { refs } : {}),
          ...(input.untrusted ? { untrusted: true } : {}),
        }
        return { store: { ...store, items: [...store.items, item] }, value: { result: { item }, fresh: true } }
      })
      if (result.fresh) {
        yield* publish(input.source === "user" ? undefined : result.result.item)
        yield* consolidateIfDue(target)
      }
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
        const next: Item = { id: randomBytes(3).toString("hex"), source: "learned", time: Date.now(), ...item }
        return { store: { ...store, items: [...store.items, next] }, value: next }
      })
      if (added) {
        yield* publish(added)
        yield* consolidateIfDue(target)
      }
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
        const target = yield* file()
        if (text !== undefined) {
          const current = (yield* read(target)).items.find((item) => item.id === id)
          if (current && indexed(current) && current.text !== text) {
            // Store-written lines (roll-ups, archived entries) stay as written; an index line keeps its format.
            if (!isIndex(current) || current.rolledInto !== undefined) return { refused: "index_format" as const }
            if (!text) return { refused: "empty" as const }
            const checked = indexRefusal({ text, missionId: current.missionId ?? "", kind: "index" })
            if (typeof checked === "string") return { refused: checked }
            const refused = refusal({ text, index: true })
            if (refused) return { refused }
          }
        }
        const refused = text === undefined ? undefined : refusal({ text })
        if (refused) return { refused }
        const item = yield* change(target, (store) => {
          const found = store.items.find((item) => item.id === id)
          if (!found) return { value: undefined }
          // Checked against the stored line above; a store changed in between keeps the line as it is.
          if (indexed(found) && text !== undefined && text !== found.text) {
            if (!isIndex(found) || found.rolledInto !== undefined) return { value: undefined }
            const checked = indexRefusal({ text, missionId: found.missionId ?? "", kind: "index" })
            if (typeof checked === "string") return { value: undefined }
            const refs = uniqueRefs([{ path: checked.report }, ...(found.refs ?? [])])
            const value: Item = {
              ...found,
              text,
              source: "user",
              ...(refs.length <= MAX_REFS ? { refs } : {}),
              ...(input.deviceOnly === undefined ? {} : { deviceOnly: input.deviceOnly }),
            }
            return { store: { ...store, items: store.items.map((item) => (item.id === id ? value : item)) }, value }
          }
          // Rewritten by the user, it is their note now and no longer ties to a command the runtime may retract. A body
          // or refs an agent wrote stay agent-written, so their untrusted flag stays with them.
          const next: Item =
            text !== undefined && text !== found.text
              ? {
                  ...found,
                  text,
                  source: "user",
                  failed: undefined,
                  worked: undefined,
                  untrusted: found.body || found.refs?.length ? found.untrusted : undefined,
                }
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
      prompt: Effect.fn("ProjectMemory.prompt")(function* (model, focus) {
        if (disabled()) return undefined
        const target = yield* file()
        const store = yield* read(target)
        if (!store.enabled) return undefined
        // T4 (01c §5): the first prompt of a store in this process brings existing memory to the vault when the hub is
        // absent or its language is stale. Background only; the returned block does not depend on it (P-05).
        if (!prompted.has(target)) {
          prompted.add(target)
          yield* refresh({ backfill: true })
        }
        const local = yield* onDevice(model)
        const items = store.items.filter((item) => local || !item.deviceOnly)
        if (!focus) return MemoryLearn.promptBlock(items, { budget: LOAD_BUDGET_TOKENS })
        if (sessions.size > 256) sessions.clear()
        const base = yield* root()
        const relative = path.relative(base, path.resolve(base, focus.directory))
        const session = sessions.get(focus.sessionID) ?? {
          focus: {
            sessionID: focus.sessionID,
            query: focus.query,
            directory: relative.startsWith("..") || path.isAbsolute(relative) ? "" : relative,
          },
        }
        // Recency moves with the clock, so the block is reused while the store is unchanged rather than re-ranked.
        const key = createHash("sha256")
          .update(JSON.stringify([local, items]))
          .digest("hex")
        if (session.key === key) return session.block
        const block = MemoryLearn.promptBlock(items, { budget: LOAD_BUDGET_TOKENS, focus: session.focus })
        sessions.set(focus.sessionID, { focus: session.focus, key, block })
        return block
      }),
      recall: Effect.fn("ProjectMemory.recall")(function* (input) {
        if (disabled()) return undefined
        const store = yield* read(yield* file())
        if (!store.enabled) return undefined
        const local = input.model ? yield* onDevice(input.model) : false
        const items = store.items.filter(
          (item) =>
            (local || !item.deviceOnly) &&
            !MemoryLearn.looksSecret(item.text) &&
            !(item.body && MemoryLearn.looksSecret(item.body)),
        )
        const query = input.query.trim()
        const found = items.find((item) => item.id === query)
        if (!found) return MemoryLearn.recallSearch(items, query)
        const resolve = refResolver(yield* root())
        const refs = yield* Effect.promise(() => Promise.all((found.refs ?? []).map(resolve)))
        return MemoryLearn.recallNote(found, refs)
      }),
      onDevice,
      mirror,
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

/**
 * The one place the U11 limits live (01h §3.2). Order: empty, long, body_long, too_many_refs, secret. A note over a
 * limit is refused whole: nothing is cut and nothing is stored. The limits are deliberately not schema `maxLength`s,
 * which would give a generic validation error with no hint.
 */
function refusal(input: {
  text: string
  body?: string
  refs?: readonly MemoryRef[]
  /** A mission index entry: its line and format were checked by indexRefusal, its body has the index limit. */
  index?: boolean
}): ProjectMemory.Refusal | undefined {
  if (!input.text) return "empty"
  if (input.text.length > MAX_TEXT) return "long"
  if (input.index && input.body && input.body.length > ProjectMemory.INDEX_LIMITS.body) return "index_body_long"
  if (input.body && input.body.length > MAX_BODY) return "body_long"
  if (input.refs && input.refs.length > MAX_REFS) return "too_many_refs"
  // L5 covers everything stored; looksSecret already includes the Secrets.scrubText shapes (SEC-09 item 4).
  const strings = [input.text, input.body ?? "", ...(input.refs ?? []).flatMap(refStrings)]
  if (strings.some((value) => value && MemoryLearn.looksSecret(value))) return "secret"
}

// ---------------------------------------------------------------------------------------------------------------------
// Mission index entries (1.2.8 F-MEM, 01e §2). `kind` is stored as a plain string: only these helpers narrow it, and any
// other value is an ordinary note.

const isIndex = (item: Item) => item.kind === "index"
/** An index entry, a roll-up or an archived entry: lines the index rules govern. An unknown kind is an ordinary note. */
const indexed = (item: Item) => isIndex(item) || item.kind === "index_rollup" || item.rolledInto !== undefined

/**
 * Rules 2-3 of 01e §2.2, in order, before anything is written: `index_long` (line over INDEX_LIMITS.text), then
 * `index_format` (kind other than "index" from a caller, no or malformed mission id, line not matching
 * INDEX_TEXT_PATTERN, mission id in the line different, not a calendar date, or a report path that is not a plain
 * relative `docs/<missionId>/....md`). Returns the report path when the line is valid.
 */
export function indexRefusal(input: {
  text: string
  missionId: string
  kind?: string
}): ProjectMemory.Refusal | { report: string; date: string } {
  if (input.text.length > ProjectMemory.INDEX_LIMITS.text) return "index_long"
  if (input.kind !== "index") return "index_format"
  if (!MISSION_ID.test(input.missionId)) return "index_format"
  const match = ProjectMemory.INDEX_TEXT_PATTERN.exec(input.text)
  if (!match) return "index_format"
  const [, date, id, , , report] = match
  if (id !== input.missionId || !calendarDate(date!) || !safeReportPath(report!, input.missionId)) return "index_format"
  return { report: report!, date: date! }
}

// ---------------------------------------------------------------------------------------------------------------------
// Roll-up (01e §5, C9, R20-C03/C04). Written, never cut: a roll-up body holds one line per member, `[<id>] <line>`, and
// every member stays whole (line, body, refs) as an archived item carrying `rolledInto`. A part that would pass
// LIMITS.body is left as it is and a new part starts; a line is never split.

/** `<period> roll-up[ part <p>] | <n> missions | triggers: t1, ... | body`; period `YYYY-Qn` or `YYYY` (N8-010). */
const ROLLUP_LINE = /^(\d{4}(?:-Q[1-4])?) roll-up(?: part (\d+))? \| (\d+) missions \| triggers: ([^|]+) \| body$/

/** Counted against INDEX_LIMITS.entries: index entries and roll-ups that are not archived. */
const liveIndex = (item: Item) => item.rolledInto === undefined && (isIndex(item) || item.kind === "index_rollup")

/**
 * Frees index slots until fewer than INDEX_LIMITS.entries are live, so the new entry dated `date` fits (01e §5.2):
 * A. the oldest quarter's live entries roll into that quarter's roll-up; B. otherwise the quarterly roll-ups of the
 * oldest year that has two or more roll into that year's roll-up; C. otherwise `index_full` and nothing changes.
 * Pure: the same items, date, time and id source give the same result. Item order is kept; new roll-ups are appended.
 */
export function rollUp(
  items: readonly Item[],
  input: { date: string; time: number; id: () => string },
): { items: Item[] } | { refused: "index_full" } {
  const work = [...items]
  for (;;) {
    const live = work.filter(liveIndex)
    if (live.length < ProjectMemory.INDEX_LIMITS.entries) return { items: work }
    const entries = live.filter(isIndex)
    if (entries.length) {
      // The oldest quarter: a complete one before the new entry's when there is one, else the current one.
      const quarter = entries.map((item) => quarterOf(entryDate(item))).toSorted()[0]!
      const members = entries
        .filter((item) => quarterOf(entryDate(item)) === quarter)
        .toSorted(
          (a, b) =>
            entryDate(a).localeCompare(entryDate(b)) || a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
      rollInto(work, quarter, members, input)
      continue
    }
    const quarterly = live.flatMap((item) => {
      const parsed = rollupOf(item)
      return parsed && parsed.period.includes("-Q") ? [{ item, ...parsed }] : []
    })
    const year = [...new Set(quarterly.map((roll) => roll.period.slice(0, 4)))]
      .toSorted()
      .find((y) => quarterly.filter((roll) => roll.period.startsWith(y)).length >= 2)
    if (!year) return { refused: "index_full" }
    const members = quarterly
      .filter((roll) => roll.period.startsWith(year))
      .toSorted((a, b) => a.period.localeCompare(b.period) || a.part - b.part || (a.item.id < b.item.id ? -1 : 1))
      .map((roll) => roll.item)
    rollInto(work, year, members, input)
  }
}

/** Appends each member's line to the newest open part of `period`, starting a new part when it would not fit. */
function rollInto(work: Item[], period: string, members: readonly Item[], input: { time: number; id: () => string }) {
  const open = work
    .filter(liveIndex)
    .flatMap((item) => {
      const parsed = rollupOf(item)
      return parsed && parsed.period === period ? [{ item, part: parsed.part }] : []
    })
    .toSorted((a, b) => b.part - a.part)[0]
  const state = { target: open?.item, part: open?.part ?? 0 }
  for (const member of members) {
    const line = `[${member.id}] ${member.text}`
    const current = state.target
    const fits = current?.body !== undefined && current.body.length + 1 + line.length <= ProjectMemory.LIMITS.body
    const body = fits ? `${current!.body}\n${line}` : line
    const part = fits ? state.part : state.part + 1
    const next: Item = {
      id: fits ? current!.id : input.id(),
      text: rollupText(period, part, body),
      source: "agent",
      deviceOnly: (fits && current!.deviceOnly) || member.deviceOnly,
      time: input.time,
      body,
      ...((fits && current!.untrusted) || member.untrusted ? { untrusted: true } : {}),
      kind: "index_rollup",
    }
    const at = work.findIndex((item) => item.id === next.id)
    if (at === -1) work.push(next)
    else work[at] = next
    const memberAt = work.findIndex((item) => item.id === member.id)
    work[memberAt] = { ...member, rolledInto: next.id }
    state.target = next
    state.part = part
  }
}

/** The roll-up line, recomputed from its body: missions behind it and its five most frequent trigger words. */
function rollupText(period: string, part: number, body: string) {
  const counts = new Map<string, number>()
  const missions = body.split("\n").reduce((total, line) => {
    const member = line.slice(line.indexOf("] ") + 2)
    const entry = ProjectMemory.INDEX_TEXT_PATTERN.exec(member)
    const roll = entry ? undefined : ROLLUP_LINE.exec(member)
    const words = (entry?.[4] ?? roll?.[4] ?? "").split(",").map((word) => word.trim())
    for (const word of words) if (word) counts.set(word, (counts.get(word) ?? 0) + 1)
    return total + (roll ? Number(roll[3]) : 1)
  }, 0)
  // Count descending, then first appearance in member order (Map keeps insertion order; the sort is stable).
  const triggers = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, ProjectMemory.INDEX_LIMITS.triggers)
    .map(([word]) => word)
  const label = part > 1 ? `${period} roll-up part ${part}` : `${period} roll-up`
  return `${label} | ${missions} missions | triggers: ${(triggers.length ? triggers : [period]).join(", ")} | body`
}

function rollupOf(item: Item) {
  if (item.kind !== "index_rollup") return undefined
  const match = ROLLUP_LINE.exec(item.text)
  return match ? { period: match[1]!, part: Number(match[2] ?? 1) } : undefined
}

/** The line date (group 1); an entry whose line was edited out of shape falls back to its write time. */
function entryDate(item: Item) {
  return ProjectMemory.INDEX_TEXT_PATTERN.exec(item.text)?.[1] ?? new Date(item.time).toISOString().slice(0, 10)
}

const quarterOf = (date: string) => `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`

function calendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
}

/** Relative, already normalised, no `..`, no `~` or `\\`, inside `docs/<missionId>/`, a Markdown file (01e §9 S-3). */
function safeReportPath(value: string, missionId: string) {
  if (value.startsWith("/") || value.startsWith("~") || value.includes("\\")) return false
  if (path.posix.normalize(value) !== value) return false
  if (value.split("/").some((part) => part === ".." || part === ".")) return false
  return value.startsWith(`docs/${missionId}/`) && value.length > `docs/${missionId}/`.length + 3 && value.endsWith(".md")
}

const refStrings = (ref: MemoryRef) => ("symbol" in ref ? [ref.symbol, ref.path ?? ""] : [ref.path])

/** A stable key for "the same reference": field order does not matter. */
export function refKey(ref: MemoryRef) {
  return "symbol" in ref ? `s\0${ref.symbol}\0${ref.path ?? ""}` : `p\0${ref.path}\0${ref.line ?? ""}`
}

function uniqueRefs(refs: readonly MemoryRef[]) {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = refKey(ref)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Absolute inside the root becomes root-relative, `..` is resolved, absolute outside the root stays absolute. */
export function normaliseRef(ref: MemoryRef, root: string): MemoryRef {
  const clean = (value: string) => {
    if (!path.isAbsolute(value)) return path.normalize(value)
    const resolved = path.resolve(value)
    const relative = path.relative(root, resolved)
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved
  }
  if ("symbol" in ref)
    return ref.path === undefined ? { symbol: ref.symbol } : { symbol: ref.symbol, path: clean(ref.path) }
  return ref.line === undefined ? { path: clean(ref.path) } : { path: clean(ref.path), line: ref.line }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reference resolution (01h §3.3, SEC-09 item 3). Reads metadata and counts lines; never returns file content.

export type ResolvedRef = {
  ref: MemoryRef
  /** `path`, `path:line` or `<file>:L<a>` when the target was found. */
  at?: string
  /** Computed, never stored: true only when the target was checked and is gone. */
  stale?: true
  /** Why the target was not checked (no graft graph, not a regular file, too large, too slow). Never stale. */
  unchecked?: string
  /** Several graft matches: the first three. Not stale. */
  ambiguous?: string[]
}

const REF_TIMEOUT_MS = 2000
const REF_STREAM_CAP = 8 * 1024 * 1024
const GRAFT_LINE = /^- (.+?) · /

type GraftIndex = { cards: { card: string; file: string; names: Map<string, number> }[] }

/** One resolver per recall or consolidation run: the graft cards are read once and shared by every ref. */
export function refResolver(root: string) {
  let graft: Promise<GraftIndex | undefined> | undefined
  const index = () => (graft ??= loadGraft(path.join(root, "graft")))
  const resolve = async (ref: MemoryRef): Promise<ResolvedRef> => {
    if ("symbol" in ref) return resolveSymbol(ref, await index())
    return resolvePath(ref, root)
  }
  return (ref: MemoryRef): Promise<ResolvedRef> =>
    withTimeout(resolve(ref), REF_TIMEOUT_MS, { ref, unchecked: "took longer than 2 s" })
}

async function withTimeout<A>(work: Promise<A>, ms: number, fallback: A): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer))
}

async function resolvePath(ref: { path: string; line?: number }, root: string): Promise<ResolvedRef> {
  // `~/x` (a global skill's SKILL.md, row 43f) is under the home folder, not the project root.
  const home = ref.path === "~" || ref.path.startsWith("~/") ? path.join(Global.Path.home, ref.path.slice(2)) : undefined
  const full = home ?? (path.isAbsolute(ref.path) ? ref.path : path.join(root, ref.path))
  const stat = await fs.lstat(full).catch((error: NodeJS.ErrnoException) => error)
  if (stat instanceof Error) {
    if (stat.code === "ENOENT" || stat.code === "ENOTDIR") return { ref, stale: true }
    return { ref, unchecked: "could not be read" }
  }
  if (ref.line === undefined) {
    if (stat.isFile() || stat.isDirectory()) return { ref, at: ref.path }
    return { ref, unchecked: "not a regular file" }
  }
  // FIFO, device, socket and symlink are never opened: a FIFO would block and /dev/zero never ends.
  if (!stat.isFile()) return { ref, unchecked: "not a regular file" }
  const lines = await countLines(full, ref.line)
  if (lines === "capped") return { ref, unchecked: "file over 8 MiB before that line" }
  return lines >= ref.line ? { ref, at: `${ref.path}:${ref.line}` } : { ref, stale: true }
}

/** Lines seen, stopping as soon as `want` is reached; "capped" past 8 MiB. Content is counted, never kept. */
function countLines(file: string, want: number) {
  return new Promise<number | "capped">((resolve, reject) => {
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 })
    let lines = 0
    let bytes = 0
    let tail = false
    stream.on("data", (chunk) => {
      const buffer = chunk as Buffer
      bytes += buffer.length
      for (const byte of buffer) if (byte === 10) lines++
      tail = buffer[buffer.length - 1] !== 10
      if (lines >= want) {
        stream.destroy()
        resolve(lines)
      } else if (bytes >= REF_STREAM_CAP) {
        stream.destroy()
        resolve("capped")
      }
    })
    stream.on("end", () => resolve(lines + (tail ? 1 : 0)))
    stream.on("error", reject)
  })
}

async function loadGraft(dir: string): Promise<GraftIndex | undefined> {
  const stat = await fs.stat(dir).catch(() => undefined)
  if (!stat?.isDirectory()) return undefined
  const entries = (await fs.readdir(dir, { recursive: true })).filter((entry) => entry.endsWith(".md"))
  const cards = await Promise.all(
    entries.map(async (entry) => {
      const text = await fs.readFile(path.join(dir, entry), "utf8").catch(() => "")
      const lines = text.split("\n")
      const header = lines[0]?.startsWith("# ") ? lines[0].slice(2).trim() : entry.slice(0, -3)
      const names = new Map<string, number>()
      for (const line of lines) {
        const match = GRAFT_LINE.exec(line)
        if (!match) continue
        const at = /· L(\d+)-L\d+/.exec(line)
        if (!names.has(match[1]!)) names.set(match[1]!, at ? Number(at[1]) : 1)
      }
      return { card: entry.slice(0, -3), file: header, names }
    }),
  )
  return { cards }
}

function resolveSymbol(ref: { symbol: string; path?: string }, graft: GraftIndex | undefined): ResolvedRef {
  if (!graft) return { ref, unchecked: "not checked (no graft graph)" }
  const parts = ref.symbol.split(".")
  const name = parts[parts.length - 1]!
  const qualifier = parts.length > 1 ? parts.slice(0, -1).join(".") : undefined
  const narrowed = ref.path?.replace(/\.[^./]+$/, "")
  const hits = graft.cards
    .filter((card) => card.names.has(name))
    .filter((card) => !ref.path || card.file === ref.path || card.card === narrowed)
    .filter((card) => !qualifier || card.names.has(qualifier))
    .map((card) => `${card.file}:L${card.names.get(name)}`)
  if (hits.length === 0) return { ref, stale: true }
  if (hits.length === 1) return { ref, at: hits[0] }
  return { ref, ambiguous: hits.slice(0, 3) }
}

async function staleRefs(items: readonly Item[], resolve: (ref: MemoryRef) => Promise<ResolvedRef>) {
  const refs = new Map<string, MemoryRef>()
  for (const item of items) if (item.source !== "user") for (const ref of item.refs ?? []) refs.set(refKey(ref), ref)
  const stale = new Set<string>()
  const queue = [...refs.entries()]
  // A few at a time: a store of 1000 notes can link many files.
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if ((await resolve(next[1])).stale) stale.add(next[0])
      }
    }),
  )
  return stale
}

// ---------------------------------------------------------------------------------------------------------------------
// Consolidation (01h §6). Pure: what changes is decided from the notes alone, so it can be tested without a store.

export function consolidationDue(store: { items: readonly unknown[]; consolidated?: Consolidated }) {
  if (store.items.length < CONSOLIDATE_AT) return false
  return !store.consolidated || store.items.length >= store.consolidated.count + CONSOLIDATE_STEP
}

const sourceRank = (source: string) => (source === "user" ? 0 : source === "agent" ? 1 : 2)
const hookKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.,;:!?]+$/, "")

export function consolidate(
  items: readonly Item[],
  options: {
    /** True for a ref that was checked and is gone. */
    stale: (ref: MemoryRef) => boolean
    /** id -> JSON of each note as read before the refs were checked; a note that differs now is left alone. */
    snapshot?: ReadonlyMap<string, string>
  },
): { items: Item[]; changed: boolean } {
  // Index entries, roll-ups, archived entries and any future kind are never merged and their refs never dropped: the
  // report link must survive the report being moved (01e §2.3).
  const settled = (item: Item) =>
    item.kind === undefined &&
    item.rolledInto === undefined &&
    (!options.snapshot || options.snapshot.get(item.id) === JSON.stringify(item))
  const drop = new Set<string>()
  const replace = new Map<string, Item>()

  // Rule 2: one lesson per failing command, the newest.
  const lessons = new Map<string, Item>()
  for (const item of items) {
    if (item.source !== "learned" || !item.failed || !settled(item)) continue
    const kept = lessons.get(item.failed)
    if (!kept) lessons.set(item.failed, item)
    else if (item.time > kept.time) {
      drop.add(kept.id)
      lessons.set(item.failed, item)
    } else drop.add(item.id)
  }

  // Rule 4: a user note only merges with an exact duplicate user note (hook, body and refs equal).
  const userGroups = new Map<string, Item[]>()
  for (const item of items) {
    if (item.source !== "user" || !settled(item)) continue
    const key = JSON.stringify([item.text, item.body ?? "", (item.refs ?? []).map(refKey)])
    userGroups.set(key, [...(userGroups.get(key) ?? []), item])
  }
  for (const group of userGroups.values()) {
    if (group.length < 2) continue
    const [keeper, ...rest] = group.toSorted((a, b) => b.time - a.time)
    for (const other of rest) drop.add(other.id)
    const deviceOnly = group.some((item) => item.deviceOnly)
    if (deviceOnly !== keeper!.deviceOnly) replace.set(keeper!.id, { ...keeper!, deviceOnly })
  }

  // Rule 1 and 3: agent and learned notes with the same hook merge; stale refs are dropped. Two notes with different
  // bodies stay apart. Nothing fuzzy, nothing model-based.
  const clusters = new Map<string, Item[]>()
  for (const item of items) {
    if (item.source === "user" || drop.has(item.id) || !settled(item)) continue
    const key = hookKey(item.text)
    clusters.set(key, [...(clusters.get(key) ?? []), item])
  }
  for (const group of clusters.values()) {
    const ordered = group.toSorted((a, b) => sourceRank(a.source) - sourceRank(b.source) || b.time - a.time)
    const merged: Item[] = []
    for (const item of ordered) {
      const index = merged.findIndex((keeper) => !keeper.body || !item.body || keeper.body === item.body)
      if (index === -1) {
        merged.push(item)
        continue
      }
      const keeper = merged[index]!
      drop.add(item.id)
      const refs = uniqueRefs([...(keeper.refs ?? []), ...(item.refs ?? [])])
      merged[index] = {
        ...keeper,
        ...(keeper.body || item.body ? { body: keeper.body ?? item.body } : {}),
        ...(refs.length ? { refs } : {}),
        deviceOnly: keeper.deviceOnly || item.deviceOnly,
        ...(keeper.untrusted || item.untrusted ? { untrusted: true } : {}),
      }
    }
    for (const note of merged) {
      const refs = (note.refs ?? []).filter((ref) => !options.stale(ref)).slice(0, MAX_REFS)
      const { refs: _old, ...rest } = note
      const next: Item = refs.length ? { ...rest, refs } : rest
      const original = items.find((item) => item.id === note.id)!
      if (JSON.stringify(next) !== JSON.stringify(original)) replace.set(note.id, next)
    }
  }

  if (drop.size === 0 && replace.size === 0) return { items: [...items], changed: false }
  return {
    items: items.filter((item) => !drop.has(item.id)).map((item) => replace.get(item.id) ?? item),
    changed: true,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage. Version 2 (1.2.6) adds body, refs, untrusted and consolidated; a version-1 file decodes unchanged. Before
// the first version-2 write the version-1 file is copied once to `<key>.json.v1`, the rollback path (01h §7, §10).

const decodeStore = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.optional(Schema.Number),
      enabled: Schema.optional(Schema.Boolean),
      items: Schema.Array(Item),
      consolidated: Schema.optional(Schema.Struct({ count: Schema.Number, time: Schema.Number })),
    }),
  ),
)

async function readStore(target: string): Promise<Stored> {
  const text = await fs.readFile(target, "utf8").catch(() => undefined)
  if (text === undefined) return { version: VERSION, enabled: true, items: [] }
  const parsed = decodeStore(text)
  if (parsed._tag === "Some")
    return {
      version: parsed.value.version ?? 1,
      enabled: parsed.value.enabled !== false,
      items: [...parsed.value.items],
      ...(parsed.value.consolidated ? { consolidated: parsed.value.consolidated } : {}),
    }
  // A file somebody edited badly must not be overwritten by the next note.
  await fs.copyFile(target, `${target}.unreadable`).catch(() => undefined)
  return { version: VERSION, enabled: true, items: [] }
}

async function writeStore(target: string, store: Stored, previous: number) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  if (previous < VERSION) {
    // Once only: an existing copy is the true pre-migration state and is never overwritten.
    const backup = `${target}.v1`
    const copied = await fs
      .copyFile(target, backup, fsConstants.COPYFILE_EXCL)
      .then(() => true)
      .catch(() => false)
    if (copied) await fs.chmod(backup, 0o600)
  }
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify({ ...store, version: VERSION }, null, 2) + "\n", { mode: 0o600 })
  await fs.rename(temporary, target)
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2Bridge.node, Provider.node],
})

export * as Memory from "./memory"
