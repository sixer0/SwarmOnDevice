import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import type { SessionID } from "@/session/schema"

// Whether a session runs without a person at the prompt, kept on the server so it holds with every window closed.
//
// Code running as the user can rewrite any file this service reads, and a test run in this very mode is such code. So
// both answers come from memory while the process lives: what a file says later never takes effect by itself. The hash
// comparison below only notices. It is a detector, not a prevention: it stops approvals, it cannot stop the write, and
// nothing here covers a file edited while no process was running.

const MODE_FILE = "mode.json"
const TRUST_FILE = "trust.json"

export type StateFile = typeof MODE_FILE | typeof TRUST_FILE

export interface Mode {
  readonly sessions: ReadonlyMap<string, boolean>
  readonly directories: ReadonlySet<string>
}

export interface Where {
  readonly root: SessionID
  readonly directory: string
}

export type ModeChange =
  | { readonly scope: "session"; readonly root: SessionID; readonly on: boolean }
  | { readonly scope: "directory"; readonly directory: string; readonly on: boolean }

export interface Check {
  readonly on: boolean
  /** Files seen to differ since the last confirmation. Holds until a person confirms, even if the bytes go back. */
  readonly externalChange: readonly StateFile[]
}

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("AutonomyWriteError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly isOn: (input: Where) => Effect.Effect<boolean>
  readonly setMode: (input: ModeChange) => Effect.Effect<void, WriteError>
  /** What the gate calls per request. On a root that is off it touches no file, so that path stays what it was. */
  readonly check: (input: Where) => Effect.Effect<Check>
  readonly externalChange: () => Effect.Effect<readonly StateFile[]>
  /** A folder's trust as this process knows it: a `trusted` written to the file from outside does not count here. */
  readonly folderState: (directory: string) => Effect.Effect<ProjectTrust.Status["state"]>
  /** The person says the change was theirs: what the files say now becomes the answer, and approvals resume. */
  readonly confirm: () => Effect.Effect<void>
  /** Trust given inside this process. Going through here keeps it from reading as a change from outside. */
  readonly grantTrust: (directory: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Autonomy") {}

/** The one way a change from outside alters a class: nothing more runs without a person. P only ever goes down. */
export const afterCheck = <Class extends string>(value: Class, check: Check) =>
  value === "P" && check.externalChange.length > 0 ? ("D" as const) : value

const folder = () => path.join(Global.Path.state, "autonomy")
const filePath = (file: StateFile) =>
  file === MODE_FILE ? path.join(folder(), MODE_FILE) : path.join(Global.Path.state, TRUST_FILE)

/** One read, so a hash and the text it is taken in from cannot be two different versions of the file. */
function readState(file: StateFile) {
  try {
    const target = filePath(file)
    // A pipe put in the file's place would block this read, and with it every prompt.
    if (!statSync(target).isFile()) return { hash: "not-a-file", text: undefined }
    const bytes = readFileSync(target)
    return { hash: hashOf(bytes), text: bytes.toString("utf8") }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown"
    return { hash: code === "ENOENT" ? "absent" : `unreadable:${code}`, text: undefined }
  }
}

const hashOf = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

function parseJSON(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Anything not exactly the agreed shape reads as off: damage to this file must never turn the mode on. */
function parseMode(text: string | undefined): Mode {
  const data = parseJSON(text)
  if (!isRecord(data) || data.v !== 1) return { sessions: new Map(), directories: new Set() }
  return {
    sessions: new Map(
      Object.entries(isRecord(data.sessions) ? data.sessions : {}).flatMap(([key, value]) =>
        typeof value === "boolean" ? [[key, value] as const] : [],
      ),
    ),
    directories: new Set(
      Object.entries(isRecord(data.directories) ? data.directories : {}).flatMap(([key, value]) =>
        value === true ? [key] : [],
      ),
    ),
  }
}

/** Same reading as ProjectTrust's own store: the keys are the trusted folders, and damage means none are. */
function parseTrust(text: string | undefined) {
  const data = parseJSON(text)
  return new Set(isRecord(data) && isRecord(data.directories) ? Object.keys(data.directories) : [])
}

function withChange(mode: Mode, change: ModeChange): Mode {
  if (change.scope === "session") return { ...mode, sessions: new Map([...mode.sessions, [change.root, change.on]]) }
  return {
    ...mode,
    directories: new Set(
      change.on
        ? [...mode.directories, change.directory]
        : [...mode.directories].filter((item) => item !== change.directory),
    ),
  }
}

function writeMode(mode: Mode) {
  const text = JSON.stringify(
    {
      v: 1,
      sessions: Object.fromEntries(mode.sessions),
      directories: Object.fromEntries([...mode.directories].map((item) => [item, true])),
    },
    null,
    2,
  )
  const file = filePath(MODE_FILE)
  mkdirSync(folder(), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, file)
  return hashOf(text)
}

/** One line in the root's audit file. An ID is not a path, whatever it spells. */
function appendAudit(root: string, at: number, line: Record<string, unknown>) {
  mkdirSync(folder(), { recursive: true, mode: 0o700 })
  writeFileSync(
    path.join(folder(), `${path.basename(root)}.jsonl`),
    `${JSON.stringify({ v: 1, at, rootID: root, ...line })}\n`,
    { flag: "a", mode: 0o600 },
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Shared by every open folder, and outliving any of them: the files are global, and a reload must not lose this.
    const firstMode = yield* Effect.sync(() => readState(MODE_FILE))
    const firstTrust = yield* Effect.sync(() => readState(TRUST_FILE))
    let mode = parseMode(firstMode.text)
    const trusted = parseTrust(firstTrust.text)
    const seen: Record<StateFile, string> = { [MODE_FILE]: firstMode.hash, [TRUST_FILE]: firstTrust.hash }
    const changed = new Set<StateFile>()
    const marked = new Set<string>()

    const isOnNow = (input: Where) => mode.sessions.get(input.root) ?? mode.directories.has(input.directory)

    const observe = () => {
      if (readState(MODE_FILE).hash !== seen[MODE_FILE]) changed.add(MODE_FILE)
      if (readState(TRUST_FILE).hash !== seen[TRUST_FILE]) changed.add(TRUST_FILE)
    }

    const setMode = Effect.fn("Autonomy.setMode")(function* (input: ModeChange) {
      yield* Effect.try({
        try: () => {
          // Before the write replaces it: a change nobody has looked at yet must not vanish under this one.
          observe()
          const next = withChange(mode, input)
          // Stopping is honoured whatever happens to the file. Starting without a saved answer is not started.
          if (!input.on) mode = next
          seen[MODE_FILE] = writeMode(next)
          mode = next
        },
        catch: String,
      }).pipe(
        Effect.tapError((error) => Effect.logError("could not save the autonomous mode", { input, error })),
        Effect.mapError(() => new WriteError({ message: "Could not save the autonomous mode" })),
      )
    })

    const check = Effect.fn("Autonomy.check")(function* (input: Where) {
      const on = isOnNow(input)
      if (!on) return { on, externalChange: [...changed] }
      yield* Effect.sync(observe)
      const open = [...changed]
      const unmarked = open.filter((file) => !marked.has(`${input.root}\0${file}`))
      if (unmarked.length === 0) return { on, externalChange: open }
      const now = yield* Clock.currentTimeMillis
      yield* Effect.try({
        try: () => {
          appendAudit(input.root, now, {
            type: "marker",
            directory: input.directory,
            marker: "external_change",
            files: unmarked,
            decidedBy: "system:external_change",
          })
          unmarked.forEach((file) => marked.add(`${input.root}\0${file}`))
        },
        catch: String,
      }).pipe(
        // Approvals stay stopped either way, and the next request tries the marker again.
        Effect.catch((error) =>
          Effect.logError("could not write the external change marker", { root: input.root, error }),
        ),
      )
      return { on, externalChange: open }
    })

    const folderState = Effect.fn("Autonomy.folderState")(function* (directory: string) {
      return yield* Effect.sync(() => {
        const live = ProjectTrust.status(directory)
        if (trusted.has(ProjectTrust.rootOf(directory))) return "trusted" as const
        if (live.state !== "trusted") return live.state
        return live.items.length > 0 ? ("ask" as const) : ("clean" as const)
      })
    })

    const confirm = Effect.fn("Autonomy.confirm")(function* () {
      yield* Effect.sync(() => {
        const nextMode = readState(MODE_FILE)
        const nextTrust = readState(TRUST_FILE)
        mode = parseMode(nextMode.text)
        trusted.clear()
        parseTrust(nextTrust.text).forEach((item) => trusted.add(item))
        seen[MODE_FILE] = nextMode.hash
        seen[TRUST_FILE] = nextTrust.hash
        changed.clear()
        marked.clear()
      })
    })

    const grantTrust = Effect.fn("Autonomy.grantTrust")(function* (directory: string) {
      return yield* Effect.sync(() => {
        observe()
        const root = ProjectTrust.trust(directory)
        // This folder only. The file may hold more than memory does, and that part is still unconfirmed.
        trusted.add(root)
        seen[TRUST_FILE] = readState(TRUST_FILE).hash
        return root
      })
    })

    return Service.of({
      isOn: (input) => Effect.sync(() => isOnNow(input)),
      setMode,
      check,
      externalChange: () => Effect.sync(() => [...changed]),
      folderState,
      confirm,
      grantTrust,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as Autonomy from "./autonomy"
