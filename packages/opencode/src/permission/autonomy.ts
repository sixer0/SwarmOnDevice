import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { Cause, Clock, Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AutonomyEvent } from "@opencode-ai/schema/autonomy-event"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"
import { Secrets } from "@/tool/secrets"

// Whether a session runs without a person at the prompt, kept on the server so it holds with every window closed.
//
// Code running as the user can rewrite any file this service reads, and a test run in this very mode is such code. So
// both answers come from memory while the process lives: what a file says later never takes effect by itself. The hash
// comparison below only notices. It is a detector, not a prevention: it stops approvals, it cannot stop the write, and
// nothing here covers a file edited while no process was running.
//
// The audit file is an operational record, not forensic evidence, for the same reason. Its hash chain notices a change
// made while this process lives, and code running as the user can rewrite the whole file while none does.

const MODE_FILE = "mode.json"
const TRUST_FILE = "trust.json"
const MAX_DIRECTORY = 1000
const MAX_SHORT_DIRECTORY = 200
const MAX_NAME = 100
const MAX_PATTERN = 300
const MAX_REASON = 200
const AUDIT_LINE_BYTES = 4096
const AUDIT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const SKIPPED_QUESTION_REASON = "asumsi agen"

/** How long everything has to stay quiet before it counts as finished: a run can pass through idle between two steps. */
export const BLOCKED_DEBOUNCE_MS = 5000

/**
 * The person is needed, because of a full queue (b0) or because nothing in this process can go on without them (b1).
 * Sent by the code below on what the code knows, never because of what a model or a file says, so it carries a count
 * and nothing that was written by anyone. A spend limit or a repeating call needs none of this: its prompt is the notice.
 */
export const Blocked = AutonomyEvent.Blocked

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

const Follow = Schema.Struct({ permission: Schema.String, patterns: Schema.Array(Schema.String) })
const Chained = {
  v: Schema.Literal(1),
  seq: Schema.Int,
  // The first line of a file has nothing before it.
  prev: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  at: Schema.Finite,
}
const DecidedBy = Schema.String.check(Schema.isPattern(/^(gate|person|agent:[^/]+\/.+|system:.+)$/))
const Decision = Schema.Struct({
  ...Chained,
  type: Schema.Literal("decision"),
  rootID: Schema.String,
  sessionID: Schema.String,
  requestID: Schema.String,
  messageID: Schema.optional(Schema.String),
  callID: Schema.optional(Schema.String),
  agent: Schema.String,
  rootAgent: Schema.optional(Schema.String),
  directory: Schema.String,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  patternsTruncated: Schema.Boolean,
  class: Schema.Literals(["A", "P", "D", "B", "X"]),
  category: Schema.optional(
    Schema.Literals([
      "check",
      "file-op",
      "git-local",
      "edit-not-ordinary",
      "outside_folder",
      "outward",
      "not_reversible",
      "sensitive_file",
      "secret_file",
      "external_tool",
      "no_undo",
      "not_routine",
      "queue_full",
      "decider_unavailable",
      "folder_not_trusted",
      "plan_mode",
      "app_state",
      "asks_every_time",
    ]),
  ),
  risk: Schema.NullOr(Schema.String),
  canUndo: Schema.Boolean,
  decidedBy: DecidedBy,
  decision: Schema.Literals(["allow", "reject", "defer", "ask"]),
  reason: Schema.optional(Schema.String),
  memo: Schema.Boolean,
  latencyMs: Schema.optional(Schema.Finite),
  costUsd: Schema.optional(Schema.Finite),
  follows: Schema.Array(Follow),
})
const Outcome = Schema.Struct({
  ...Chained,
  type: Schema.Literal("outcome"),
  requestID: Schema.String,
  outcome: Schema.Literals(["ran", "failed", "not_run", "approved_later", "rejected_later", "abandoned", "undone"]),
  exit: Schema.optional(Schema.Finite),
  by: Schema.optional(DecidedBy),
})
const Marker = Schema.Struct({
  ...Chained,
  type: Schema.Literal("marker"),
  rootID: Schema.String,
  directory: Schema.optional(Schema.String),
  marker: Schema.Literals([
    "external_change",
    "mode_on",
    "mode_off",
    "decider_open",
    "decider_closed",
    "decider_limit",
    "b0",
    "b1",
  ]),
  files: Schema.optional(Schema.Array(Schema.Literals([MODE_FILE, TRUST_FILE]))),
  decidedBy: DecidedBy,
})
/** One line of `autonomy/<rootID>.jsonl`. */
export const AuditLine = Schema.Union([Decision, Outcome, Marker])
export type AuditLine = typeof AuditLine.Type

type DecidedByName = "gate" | "person" | `agent:${string}/${string}` | `system:${string}`
type Unchained<Line> = Omit<Line, "v" | "seq" | "prev" | "at">

/**
 * What a caller may hand in, field by field. The line is built from these names only, so a diff, a tool's output or the
 * goal cannot reach the file by being passed along in an object.
 */
export type AuditEntry =
  | (Omit<
      Unchained<typeof Decision.Type>,
      "rootID" | "patternsTruncated" | "risk" | "memo" | "follows" | "decidedBy"
    > & {
      readonly decidedBy: DecidedByName
      readonly risk?: string | null
      readonly memo?: boolean
      readonly follows?: typeof Decision.Type.follows
    })
  | (Omit<Unchained<typeof Outcome.Type>, "by"> & { readonly by?: DecidedByName })
  | (Omit<Unchained<typeof Marker.Type>, "rootID" | "decidedBy"> & { readonly decidedBy: DecidedByName })

export interface SkippedQuestion {
  readonly root: SessionID
  readonly sessionID: SessionID
  readonly directory: string
  readonly agent: string
  readonly messageID: string
  readonly callID?: string
  /** The questions' own text. There is deliberately no place for an answer: nobody gave one. */
  readonly questions: readonly string[]
}

export interface AuditRead {
  readonly lines: readonly AuditLine[]
  /** False when the chain does not hold. A file rewritten whole while no process ran still reads true. */
  readonly intact: boolean
  readonly problems: readonly string[]
  /**
   * Lines after the last one this service wrote. Another process appending looks exactly like a forged line chained on
   * the head, so this is a count to show and not a verdict. It is 0 while this service is the only writer.
   */
  readonly notFromHere: number
}

/** A held call nobody has answered, as its line in the audit file says it. */
export type OpenDecision = typeof Decision.Type

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
  /** One line in the root's audit file. A failure is the caller's to weigh: nothing is retried or dropped silently here. */
  readonly record: (root: SessionID, entry: AuditEntry) => Effect.Effect<void, WriteError>
  /** The `question` tool does not pass the gate, so it says here that a run went on by its own assumption. */
  readonly recordSkippedQuestion: (input: SkippedQuestion) => Effect.Effect<void, WriteError>
  /** Notes the root's mode when it differs from what its file last said. A root that was never on writes nothing. */
  readonly markMode: (input: Where) => Effect.Effect<void>
  readonly readAudit: (root: SessionID) => Effect.Effect<AuditRead>
  /** Every root's held calls still open, oldest first per root. What is in the file only ever becomes a question. */
  readonly openDecisions: () => Effect.Effect<readonly OpenDecision[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Autonomy") {}

type Lineage = { id: SessionID; parentID?: SessionID; directory?: string; time?: { archived?: number } }

/**
 * Where a session's mode is read: the session at the top of its line, and the folder that one was opened in. A subagent can
 * run in another folder and still goes by this one. A session that cannot be read is its own root, in the folder running it.
 */
export const placeOf = Effect.fnUntraced(function* (
  sessions: { readonly get: (id: SessionID) => Effect.Effect<Lineage, unknown> },
  sessionID: SessionID,
) {
  const rootOf = (id: SessionID): Effect.Effect<Lineage> =>
    sessions.get(id).pipe(
      Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session))),
      Effect.catchCause(() => Effect.succeed({ id })),
    )
  const root = yield* rootOf(sessionID)
  return { root, directory: root.directory ?? (yield* InstanceState.directory) }
})

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

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(AuditLine))
const auditFile = (id: string) => path.join(folder(), `${id}.jsonl`)

/** A pattern can be a command, and a command can hold a secret typed into its arguments. */
/** A prompt's or a command's text with what looks like a secret masked, on one printable line. */
export const hide = (text: string, directory: string, limit = Number.POSITIVE_INFINITY) =>
  ProjectTrust.printable(Secrets.scrub(Secrets.scrubText(text), directory), limit)

function auditFields(root: string, entry: AuditEntry) {
  if (entry.type === "outcome")
    return {
      type: entry.type,
      requestID: ProjectTrust.printable(entry.requestID, MAX_NAME),
      outcome: entry.outcome,
      exit: entry.exit,
      by: entry.by && ProjectTrust.printable(entry.by, MAX_NAME),
    }
  if (entry.type === "marker")
    return {
      type: entry.type,
      rootID: ProjectTrust.printable(root, MAX_NAME),
      directory: entry.directory && ProjectTrust.printable(entry.directory, MAX_DIRECTORY),
      marker: entry.marker,
      files: entry.files,
      decidedBy: ProjectTrust.printable(entry.decidedBy, MAX_NAME),
    }
  const patterns = entry.patterns.map((item) => hide(item, entry.directory))
  return {
    type: entry.type,
    rootID: ProjectTrust.printable(root, MAX_NAME),
    sessionID: ProjectTrust.printable(entry.sessionID, MAX_NAME),
    requestID: ProjectTrust.printable(entry.requestID, MAX_NAME),
    messageID: entry.messageID && ProjectTrust.printable(entry.messageID, MAX_NAME),
    callID: entry.callID && ProjectTrust.printable(entry.callID, MAX_NAME),
    agent: ProjectTrust.printable(entry.agent, MAX_NAME),
    rootAgent: entry.rootAgent && ProjectTrust.printable(entry.rootAgent, MAX_NAME),
    directory: ProjectTrust.printable(entry.directory, MAX_DIRECTORY),
    permission: ProjectTrust.printable(entry.permission, MAX_NAME),
    patterns: patterns.map((item) => ProjectTrust.printable(item, MAX_PATTERN)),
    patternsTruncated: patterns.some((item) => item.length > MAX_PATTERN),
    class: entry.class,
    category: entry.category,
    risk: entry.risk === undefined || entry.risk === null ? null : ProjectTrust.printable(entry.risk, MAX_NAME),
    canUndo: entry.canUndo,
    decidedBy: ProjectTrust.printable(entry.decidedBy, MAX_NAME),
    decision: entry.decision,
    reason: entry.reason === undefined ? undefined : hide(entry.reason, entry.directory, MAX_REASON),
    memo: entry.memo ?? false,
    latencyMs: entry.latencyMs,
    costUsd: entry.costUsd,
    follows: (entry.follows ?? []).map((item) => ({
      permission: ProjectTrust.printable(item.permission, MAX_NAME),
      patterns: item.patterns.map((pattern) => hide(pattern, entry.directory, MAX_PATTERN)),
    })),
  }
}

type Fields = ReturnType<typeof auditFields>

/** What goes first when a line is too long: the rest of the list, then the model's words, and the first pattern last. */
function smaller(fields: Fields): Fields[] {
  const short =
    "directory" in fields && fields.directory
      ? { ...fields, directory: ProjectTrust.printable(fields.directory, MAX_SHORT_DIRECTORY) }
      : fields
  if (short.type !== "decision") return [short]
  const base = { ...short, follows: [], patternsTruncated: true }
  return [
    ...base.patterns.slice(1).map((_, index) => ({
      ...base,
      patterns: base.patterns.slice(0, base.patterns.length - 1 - index),
    })),
    { ...base, patterns: base.patterns.slice(0, 1), reason: undefined },
    { ...base, patterns: [], reason: undefined },
  ]
}

// Under the limit one write to a file opened for append reaches it whole, even with other processes writing too.
function encodeLine(chain: { v: 1; seq: number; prev: string | null; at: number }, fields: Fields) {
  const fits = (text: string) => Buffer.byteLength(text) < AUDIT_LINE_BYTES
  const whole = JSON.stringify({ ...chain, ...fields })
  if (fits(whole)) return whole
  const fitted = smaller(fields)
    .map((item) => JSON.stringify({ ...chain, ...item }))
    .find(fits)
  if (fitted === undefined) throw new Error("audit line is over the limit")
  return fitted
}

/** A pipe put in the file's place would block a read, and with it every prompt. A link would write somewhere else. */
function readAuditText(file: string) {
  const found = lstatSync(file, { throwIfNoEntry: false })
  if (!found) return ""
  if (!found.isFile()) throw new Error("audit path is not a regular file")
  return readFileSync(file, "utf8")
}

/** Where a service that has not written to this file yet picks the chain up. */
function tailOf(file: string) {
  const text = readAuditText(file)
  const lines = text.split("\n").filter(Boolean)
  const last = lines.at(-1)
  if (last === undefined) return { seq: 0, hash: null, torn: false }
  return {
    seq: Option.getOrUndefined(decodeLine(last))?.seq ?? lines.length,
    hash: hashOf(last),
    torn: !text.endsWith("\n"),
  }
}

function writeAudit(file: string, text: string) {
  const bytes = Buffer.from(text)
  // O_NONBLOCK makes a pipe without a reader an error instead of a wait. The mode only applies when the file is created.
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  )
  try {
    if (!fstatSync(fd).isFile()) throw new Error("audit path is not a regular file")
    fchmodSync(fd, 0o600)
    return writeSync(fd, bytes) === bytes.length
  } finally {
    closeSync(fd)
  }
}

function verifyAudit(text: string, head: string | null | undefined): AuditRead {
  const raw = text.split("\n").filter(Boolean)
  const decoded = raw.map((line) => decodeLine(line))
  const hashes = raw.map((line) => hashOf(line))
  const firstAt = new Map(hashes.toReversed().map((hash, index) => [hash, raw.length - 1 - index]))
  const problems = raw.flatMap((_, index) => {
    const line = decoded[index]
    if (Option.isNone(line)) return [`line ${index + 1} is not a valid entry`]
    if (firstAt.get(hashes[index]) !== index) return [`line ${index + 1} repeats an earlier line`]
    // Writers that start together can all find the file empty, so a file may have several first lines. Only the seq says so.
    if (line.value.prev === null) return line.value.seq === 1 ? [] : [`line ${index + 1} claims to be the first`]
    return (firstAt.get(line.value.prev) ?? index) < index ? [] : [`line ${index + 1} follows a line that is not there`]
  })
  const headAt = typeof head === "string" ? hashes.indexOf(head) : undefined
  return {
    lines: decoded.flatMap((line) => (Option.isSome(line) ? [line.value] : [])),
    intact: problems.length === 0 && headAt !== -1,
    problems: headAt === -1 ? [...problems, "the last line written here is gone or changed"] : problems,
    notFromHere: headAt === undefined || headAt === -1 ? 0 : raw.length - 1 - headAt,
  }
}

function openIn(text: string, id: string) {
  const lines = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const decoded = decodeLine(line)
      return Option.isSome(decoded) ? [decoded.value] : []
    })
  const answered = new Set(
    lines.flatMap((line) =>
      line.type === "outcome" && ["approved_later", "rejected_later", "abandoned"].includes(line.outcome)
        ? [line.requestID]
        : [],
    ),
  )
  return lines.filter(
    (line): line is OpenDecision =>
      line.type === "decision" &&
      line.rootID === id &&
      line.decision === "defer" &&
      // Class A with "defer" is a skipped question, which nobody is asked to answer. A full queue took nothing in.
      (line.class === "D" || line.class === "P") &&
      line.category !== "queue_full" &&
      !answered.has(line.requestID),
  )
}

const auditIDs = () =>
  readdirSync(folder())
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))

function sweepAudit(now: number) {
  auditIDs()
    .filter((id) => {
      const found = lstatSync(auditFile(id))
      if (!found.isFile() || now - found.mtimeMs <= AUDIT_RETENTION_DAYS * DAY_MS) return false
      // A decision waits as long as it takes, and this file is the only thing that remembers it across a restart.
      return openIn(readAuditText(auditFile(id)), id).length === 0
    })
    .forEach((id) => rmSync(auditFile(id), { force: true }))
}

/** The root's file, for when the person deleted the session and asked for its data to go with it. Needs no live state. */
export const removeAudit = Effect.fn("Autonomy.removeAudit")(function* (root: SessionID) {
  yield* Effect.try({ try: () => rmSync(auditFile(path.basename(root)), { force: true }), catch: String }).pipe(
    Effect.catch((error) => Effect.logError("could not remove an audit file", { root, error })),
  )
})

const isStatus = Schema.is(SessionStatusEvent.Status.data)
const isIdle = Schema.is(SessionStatusEvent.Idle.data)
const isPrompt = Schema.is(
  Schema.Struct({
    id: Schema.String,
    sessionID: Schema.String,
    movesOnAt: Schema.optional(Schema.Number),
    movedOnAt: Schema.optional(Schema.Number),
  }),
)
const isAnswer = Schema.is(Schema.Struct({ requestID: Schema.String }))
const PROMPT_ASKED: readonly string[] = [PermissionV1.Event.Asked.type, QuestionV1.Event.Asked.type]
const PROMPT_ANSWERED: readonly string[] = [
  PermissionV1.Event.Replied.type,
  QuestionV1.Event.Replied.type,
  QuestionV1.Event.Rejected.type,
]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Absent only where the layer is built alone to read and write its files, and there is nobody to tell then.
    const events = Option.getOrUndefined(yield* Effect.serviceOption(EventV2.Service))
    const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
    // Shared by every open folder, and outliving any of them: the files are global, and a reload must not lose this.
    const firstMode = yield* Effect.sync(() => readState(MODE_FILE))
    const firstTrust = yield* Effect.sync(() => readState(TRUST_FILE))
    let mode = parseMode(firstMode.text)
    const trusted = parseTrust(firstTrust.text)
    const seen: Record<StateFile, string> = { [MODE_FILE]: firstMode.hash, [TRUST_FILE]: firstTrust.hash }
    const changed = new Set<StateFile>()
    const marked = new Set<string>()
    // The chain's head for each root this service wrote to. A change to the file cannot reach it.
    const heads = new Map<string, { seq: number; hash: string | null; torn: boolean }>()
    const modeMarked = new Map<string, boolean>()
    // What can still go on, across every open folder: SessionStatus and the prompts each keep theirs per folder.
    const running = new Map<string, string | undefined>()
    const prompts = new Map<string, { sessionID: string; directory: string | undefined }>()
    // Sessions that went idle since the last look. A root nothing happened to since a restart stays quiet until it runs.
    const idled = new Set<string>()
    // Per root, the held calls a b1 already named. Saying the same again adds nothing anyone can act on.
    const told = new Map<string, ReadonlySet<string>>()
    let lastIdle = 0

    const started = yield* Clock.currentTimeMillis
    yield* Effect.try({ try: () => sweepAudit(started), catch: String }).pipe(
      // A folder that is not there yet has nothing old in it.
      Effect.catch((error) =>
        error.includes("ENOENT") ? Effect.void : Effect.logError("could not sweep old audit files", { error }),
      ),
    )

    const isOnNow = (input: Where) => mode.sessions.get(input.root) ?? mode.directories.has(input.directory)

    const observe = () => {
      if (readState(MODE_FILE).hash !== seen[MODE_FILE]) changed.add(MODE_FILE)
      if (readState(TRUST_FILE).hash !== seen[TRUST_FILE]) changed.add(TRUST_FILE)
    }

    // In one synchronous stretch, so two callers in this process can never take the same place in the chain.
    const appendAudit = (root: string, at: number, entry: AuditEntry) => {
      // An ID is not a path, whatever it spells.
      const id = path.basename(root)
      const file = auditFile(id)
      mkdirSync(folder(), { recursive: true, mode: 0o700 })
      const head = heads.get(id) ?? tailOf(file)
      const seq = head.seq + 1
      const text = encodeLine({ v: 1, seq, prev: head.hash, at }, auditFields(root, entry))
      if (!writeAudit(file, `${head.torn ? "\n" : ""}${text}\n`)) {
        // Part of a line is in the file now: read the tail again, so the next one starts on a line of its own.
        heads.delete(id)
        throw new Error("audit line was only partly written")
      }
      heads.set(id, { seq, hash: hashOf(text), torn: false })
    }

    const tell = Effect.fnUntraced(function* (root: string, directory: string, level: "b0" | "b1") {
      if (!events) return
      const id = path.basename(root)
      const open = yield* Effect.try({ try: () => openIn(readAuditText(auditFile(id)), id), catch: String }).pipe(
        // Someone is still needed, and a queue that cannot be read now is no reason to keep that from them.
        Effect.catch((error) =>
          Effect.logError("could not read an audit file", { root, error }).pipe(Effect.as([] as OpenDecision[])),
        ),
      )
      const asking = yield* Effect.forEach([...prompts.values()], (item) => rootOf(item.sessionID))
      // Only b1. A full queue says work is still going on, and whoever let that pass still has to hear when it stops.
      if (level === "b1") told.set(id, new Set(open.map((line) => line.requestID)))
      yield* events.publish(
        Blocked,
        // Everything under this root waiting on a person: what was held, and what is asking right now.
        { sessionID: root, level, count: open.length + asking.filter((item) => item?.root === root).length },
        // Clients take events by folder, and this one may be sent from a timer that belongs to none.
        { location: { directory: AbsolutePath.make(directory) } },
      )
    })

    const record = Effect.fn("Autonomy.record")(function* (root: SessionID, entry: AuditEntry) {
      const at = yield* Clock.currentTimeMillis
      yield* Effect.try({ try: () => appendAudit(root, at, entry), catch: String }).pipe(
        Effect.tapError((error) => Effect.logError("could not write to the audit file", { root, error })),
        Effect.mapError(() => new WriteError({ message: "Could not write to the audit file" })),
      )
      if (entry.type !== "marker" || entry.marker !== "b0" || !entry.directory) return
      if (entry.decidedBy !== "system:queue_full") return
      yield* tell(root, entry.directory, "b0").pipe(
        // The line is written, and the queue being full is not undone by a notice that failed.
        Effect.catchCause((cause) => Effect.logError("could not send a notice", { root, cause })),
      )
    })

    const markMode = Effect.fn("Autonomy.markMode")(function* (input: Where) {
      const on = isOnNow(input)
      const last = modeMarked.get(input.root) ?? false
      if (on === last) return
      yield* record(input.root, {
        type: "marker",
        directory: input.directory,
        marker: on ? "mode_on" : "mode_off",
        decidedBy: "system:mode_change",
      }).pipe(
        Effect.tap(() => Effect.sync(() => modeMarked.set(input.root, on))),
        // Logged by record, and the next request tries again.
        Effect.ignore,
      )
    })

    const recordSkippedQuestion = Effect.fn("Autonomy.recordSkippedQuestion")(function* (input: SkippedQuestion) {
      yield* record(input.root, {
        type: "decision",
        sessionID: input.sessionID,
        // A question has no permission request, and the call is what its entry in the session is known by.
        requestID: input.callID ?? input.messageID,
        messageID: input.messageID,
        callID: input.callID,
        agent: input.agent,
        directory: input.directory,
        permission: "question",
        patterns: input.questions,
        class: "A",
        canUndo: false,
        decidedBy: "gate",
        // Not answered, and still open for later.
        decision: "defer",
        reason: SKIPPED_QUESTION_REASON,
      })
    })

    const readAudit = Effect.fn("Autonomy.readAudit")(function* (root: SessionID) {
      const id = path.basename(root)
      const read = yield* Effect.try({
        try: () => verifyAudit(readAuditText(auditFile(id)), heads.get(id)?.hash),
        catch: String,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ lines: [], intact: false, problems: [`not readable: ${error}`], notFromHere: 0 }),
        ),
      )
      if (!read.intact) yield* Effect.logError("the audit chain does not hold", { root, problems: read.problems })
      return read
    })

    const openDecisions = Effect.fn("Autonomy.openDecisions")(function* () {
      const ids = yield* Effect.try({ try: auditIDs, catch: String }).pipe(
        // A folder that is not there yet has nothing open in it.
        Effect.catch((error) =>
          error.includes("ENOENT")
            ? Effect.succeed([])
            : Effect.logError("could not list the audit files", { error }).pipe(Effect.as([])),
        ),
      )
      const found = yield* Effect.forEach(ids, (id) =>
        Effect.try({ try: () => openIn(readAuditText(auditFile(id)), id), catch: String }).pipe(
          Effect.catch((error) =>
            Effect.logError("could not read an audit file", { root: id, error }).pipe(Effect.as([])),
          ),
        ),
      )
      return found.flat()
    })

    const rootOf = (id: string): Effect.Effect<{ root: SessionID; directory: string } | undefined> =>
      database
        ? database.db
            .select({ parent: SessionTable.parent_id, directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, id as SessionID))
            .get()
            .pipe(
              Effect.orDie,
              Effect.flatMap((row) => {
                if (!row) return Effect.succeed(undefined)
                if (row.parent) return rootOf(row.parent)
                return Effect.succeed({ root: id as SessionID, directory: row.directory })
              }),
            )
        : Effect.succeed(undefined)

    /**
     * GATE 6. An agent is told to carry on with whatever else it can and end its turn when there is nothing left, so a
     * root in the mode with nothing moving anywhere and a decision open means the person is the only way forward. Any
     * root in the mode still moving keeps every other one waiting: asking is the last resort, and what it finds may
     * clear the way. A failure to look says nothing, and the queue stays where it is in Activity.
     */
    const lookAtBlocked = Effect.gen(function* () {
      const moving = yield* Effect.forEach(
        [...running.keys(), ...[...prompts.values()].map((item) => item.sessionID)],
        rootOf,
      )
      if (moving.some((item) => item && isOnNow({ root: item.root, directory: item.directory }))) return
      const finished = new Map(
        (yield* Effect.forEach([...idled], rootOf)).flatMap((item) => (item ? [[item.root, item] as const] : [])),
      )
      idled.clear()
      yield* Effect.forEach(
        [...finished.values()].filter((item) => isOnNow({ root: item.root, directory: item.directory })),
        Effect.fnUntraced(function* (item) {
          const id = path.basename(item.root)
          const known = told.get(id)
          const open = openIn(readAuditText(auditFile(id)), id)
          if (open.every((line) => known?.has(line.requestID))) return
          yield* record(item.root, {
            type: "marker",
            directory: item.directory,
            marker: "b1",
            decidedBy: "system:blocked",
          }).pipe(Effect.ignore)
          yield* tell(item.root, item.directory, "b1")
        }),
        { discard: true },
      )
    })

    if (events && database) {
      const scope = yield* Scope.Scope
      const look = Effect.suspend(() => {
        const mine = ++lastIdle
        return Effect.sleep(BLOCKED_DEBOUNCE_MS).pipe(
          Effect.andThen(Effect.suspend(() => (mine === lastIdle ? lookAtBlocked : Effect.void))),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("could not work out whether a person is needed", { cause }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      })

      // What still stops a run in this mode, a spend limit, a repeating call or the question ending a plan, is the last
      // resort actually reached. It gets through even when its line in the audit file does not.
      const alertPerson = (sessionID: string) =>
        rootOf(sessionID).pipe(
          Effect.flatMap((place) => {
            if (!place || !isOnNow({ root: place.root, directory: place.directory })) return Effect.void
            return record(place.root, {
              type: "marker",
              directory: place.directory,
              marker: "b0",
              decidedBy: "system:needs_person",
            }).pipe(Effect.ignore, Effect.andThen(tell(place.root, place.directory, "b0")))
          }),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("could not send a notice", { sessionID, cause }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        )

      const unsubscribe = yield* events.listen((event) =>
        Effect.suspend(() => {
          const data = event.data
          const directory = event.location?.directory
          if (event.type === SessionStatusEvent.Status.type && isStatus(data)) {
            if (data.status.type !== "idle") {
              running.set(data.sessionID, directory)
              return Effect.void
            }
            running.delete(data.sessionID)
            // A prompt lives inside a run. A cancelled one takes its prompt with it, and nothing is published about that.
            prompts.forEach((item, id) => {
              if (item.sessionID === data.sessionID) prompts.delete(id)
            })
            return Effect.void
          }
          if (event.type === SessionStatusEvent.Idle.type && isIdle(data)) {
            idled.add(data.sessionID)
            return look
          }
          if (PROMPT_ASKED.includes(event.type) && isPrompt(data)) {
            // A held call and a prompt that moved on are both published with this set, and neither is waiting for anyone.
            if (data.movedOnAt !== undefined) {
              prompts.delete(data.id)
              return Effect.void
            }
            const again = prompts.has(data.id)
            prompts.set(data.id, { sessionID: data.sessionID, directory })
            // One with a time to move on at does not hold the run. Nothing here is told more than once per request.
            return again || data.movesOnAt !== undefined ? Effect.void : alertPerson(data.sessionID)
          }
          if (PROMPT_ANSWERED.includes(event.type) && isAnswer(data)) prompts.delete(data.requestID)
          return Effect.void
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      // A folder being closed publishes nothing for the runs it ends. Left alone, one of them would hold back every
      // notice in this process for as long as it lives.
      const onClosed = (event: GlobalEvent) => {
        if (event.payload?.type !== "server.instance.disposed") return
        running.forEach((directory, id) => {
          if (directory === event.directory) running.delete(id)
        })
        prompts.forEach((item, id) => {
          if (item.directory === event.directory) prompts.delete(id)
        })
        Effect.runFork(look)
      }
      GlobalBus.on("event", onClosed)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onClosed)))
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
      record,
      recordSkippedQuestion,
      markMode,
      readAudit,
      openDecisions,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2.node, Database.node] })

export * as Autonomy from "./autonomy"
