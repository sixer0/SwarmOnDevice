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
import { Cause, Clock, Context, Deferred, Effect, Layer, Option, Schema, Scope } from "effect"
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AutonomyEvent } from "@opencode-ai/schema/autonomy-event"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"
import { Secrets } from "@/tool/secrets"
import type { Archive } from "@/tool/archive"
import type { ActionCheckpoint } from "@/tool/checkpoint"
import { ConsentScan } from "./consent-scan"
import { MissionWindow } from "./mission-window"
import { OutwardKnown } from "./outward-known"
import { ScriptReader } from "./script-reader"

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
const MAX_MOVED = 10
const MAX_MOVED_PATH = 150
const MAX_FLAGS = 10
const AUDIT_LINE_BYTES = 4096
const AUDIT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const SKIPPED_QUESTION_REASON = "asumsi agen"
// The gate waits this long for the consent list before its first call. Past it the call goes on, and what the list would
// have covered stays held.
const CONSENT_WAIT_MS = 15_000
// Person messages read to find the mission: far more than the window's 3 before the switch and whatever came since.
const MISSION_MESSAGES = 100
// 1.1.1 F30 (CR12-5, G12-P1): the live read of the person's hosts takes new messages in pages of this many, at most this
// many pages a call (what is left is read at the next call). A message's stored time may differ a little from the time it
// carries, so the reads reach this far either side of the switch and judge by the time the message carries.
const MISSION_PAGE = 500
const MISSION_PAGES = 20
const MISSION_SLACK_MS = 60_000
// 1.1.1 F33 (CR13-8): a person message still without parts is waited for this long, then passed over.
const PARTS_WAIT_MS = 10_000

/** Test seam (1.1.1 F30, CR12-5): message rows the live host read looked at, and how many of them it read in full;
 * 1.1.1 F39 (G15-P1): how many revert checks it made (one statement each). */
export const missionCounters = { rows: 0, hydrated: 0, anchors: 0 }

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

/** The one consent text version the app shows before the main agent may decide during a run (1.1.1, S0.1). */
export const BYPASS_CONSENT = "bypass-v1" as const
export type BypassConsent = typeof BYPASS_CONSENT
export type ReportLanguage = "en" | "id"

/** Consent fields ride with `on: true`; without `bypassConsent` the mode behaves exactly as in 1.1.0. */
interface ModeConsent {
  readonly bypassConsent?: BypassConsent
  readonly reportLanguage?: ReportLanguage
}

export type ModeChange =
  | ({ readonly scope: "session"; readonly root: SessionID; readonly on: boolean } & ModeConsent)
  | ({ readonly scope: "directory"; readonly directory: string; readonly on: boolean } & ModeConsent)

export interface Check {
  readonly on: boolean
  /** Files seen to differ since the last confirmation. Holds until a person confirms, even if the bytes go back. */
  readonly externalChange: readonly StateFile[]
}

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("AutonomyWriteError", {
  message: Schema.String,
}) {}

/** The list the person answered is not the one on show: the mode went off, the process restarted, or it was made again. */
export class ConsentError extends Schema.TaggedErrorClass<ConsentError>()("AutonomyConsentError", {
  message: Schema.String,
}) {}

/**
 * What one root was asked once its mission was known (U11 rule 2, U13), and what the person allowed. Memory only: it is
 * gone when the mode goes off or the process ends, and nothing in a file brings it back.
 */
export interface Consent {
  readonly id: string
  readonly hash: string
  readonly at: number
  readonly directory: string
  readonly items: readonly ConsentScan.Item[]
  /** Item ids a person allowed through the server's own route. Nothing an agent or a file says adds to this. */
  readonly given: ReadonlySet<string>
  readonly stopped?: ConsentScan.Result["stopped"]
  readonly dropped: number
  /** What was known about destinations before anything this run did could change it, for the push recheck. */
  readonly snapshot?: OutwardKnown.Snapshot
  /** The known destinations behind each `destination` item, by item id. */
  readonly destinations: ReadonlyMap<string, OutwardKnown.Destination>
}

/** The allowed item that names this concrete path, if any. A pattern on its own covers nothing. */
export const consentedFile = (consent: Consent | undefined, file: string) =>
  consent?.items.find((item) => consent.given.has(item.id) && item.files.includes(file))

/** The allowed destinations, as row 107 matches a call against them. */
export const consentedDestinations = (consent: Consent | undefined) =>
  consent
    ? [...consent.destinations].flatMap(([id, destination]) => (consent.given.has(id) ? [{ id, destination }] : []))
    : []

const Follow = Schema.Struct({ permission: Schema.String, patterns: Schema.Array(Schema.String) })
const Chained = {
  v: Schema.Literal(1),
  seq: Schema.Int,
  // The first line of a file has nothing before it.
  prev: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  at: Schema.Finite,
}
const DecidedBy = Schema.String.check(Schema.isPattern(/^(gate|person|agent:[^/]+\/.+|system:.+)$/))
// The schema's category names (`PermissionV1`), in the order the generated API lists them, after the table's own.
const DecisionCategory = Schema.Literals([
  "check",
  "file-op",
  "git-local",
  "edit-not-ordinary",
  ...PermissionV1.DeferredCategory.literals,
  ...PermissionV1.AllowedCategory.literals,
])
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
  category: Schema.optional(DecisionCategory),
  // Under the consented bypass: the category the call had before the overlay changed it (S1.43).
  bypassed: Schema.optional(DecisionCategory),
  // `main_agent`: the root's own call, decided by the main agent; `for_subagent`: the main agent decided for a subagent.
  via: Schema.optional(
    Schema.Literals(["grant", "duplicate", "consent", "outward", "user_request", "main_agent", "for_subagent"]),
  ),
  duplicateOf: Schema.optional(Schema.String),
  consentID: Schema.optional(Schema.String),
  // 1.1.1 F26 (P42): where a call the consented bypass let out sends: `host[:port]` for a request, a remote name for a
  // push, a registry or target for a publish, image push or deploy; comma separated. Only on such a line.
  destination: Schema.optional(Schema.String),
  attempts: Schema.optional(Schema.Int),
  script: Schema.optional(
    Schema.Struct({
      bytes: Schema.Int,
      sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      flags: Schema.Array(Schema.String),
    }),
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
  outcome: Schema.Literals([
    "ran",
    "failed",
    "not_run",
    "approved_later",
    "rejected_later",
    "abandoned",
    "undone",
    "archived",
    // 1.2.6 row 37b (N-074): a checkpoint was saved before the call ran, as `ActionCheckpoint.CheckpointedLine` names it.
    "checkpointed",
  ]),
  exit: Schema.optional(Schema.Finite),
  by: Schema.optional(DecidedBy),
  // Only on `archived`, as `Archive.ArchivedLine` in `tool/archive.ts` names them. Paths are relative to the session folder.
  archive: Schema.optional(Schema.String),
  moved: Schema.optional(Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String }))),
  bytes: Schema.optional(Schema.Int),
  // Only on `checkpointed` (tool/checkpoint.ts): the id, how many entries and refs it holds, and the sha256 of its
  // manifest, which a revert must present (SEC-07). No path, so no home folder reaches the audit.
  checkpoint: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{8}-\d{6}-\d{1,4}$/))),
  entries: Schema.optional(Schema.Int),
  refs: Schema.optional(Schema.Int),
  manifestSha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
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
    "consent_shown",
    "consent_given",
    "consent_cleared",
    "archive_emptied",
    "credential_snapshot",
    "subagent_stopped",
    "force_stop",
    "bypass_on",
    "bypass_report",
  ]),
  files: Schema.optional(Schema.Array(Schema.Literals([MODE_FILE, TRUST_FILE]))),
  // Only on the consent markers: which list, and its hash, so a line can be matched to what the person saw.
  consentID: Schema.optional(Schema.String),
  hash: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
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
  | (Omit<Unchained<typeof Outcome.Type>, "by"> & {
      readonly by?: DecidedByName
      // Never written: it only lets the paths of an `archived` line be masked like a pattern is.
      readonly directory?: string
    })
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

/**
 * The person's consent that the main agent decides during this activation (1.1.1, S1.2). Memory only: no file sets it, a
 * restart forgets it, and switching the mode on without the consent or off takes it away.
 */
export interface Bypass {
  readonly at: number
  readonly language: ReportLanguage
}

/** A consented run that has ended, handed to the end-report hook (S1.42). */
export interface EndedRun {
  readonly root: SessionID
  readonly directory: string
  readonly since: number
  readonly until: number
  readonly language: ReportLanguage
}

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
  /** When the root's mode came on in this run of it: its first mode_on after the last mode_off. */
  readonly modeSince: (root: SessionID) => Effect.Effect<number | undefined>
  /** The root's consent list, once its scan is done. Undefined while there is no mission yet, or the mode is off. */
  readonly consent: (root: SessionID) => Effect.Effect<Consent | undefined>
  /**
   * 1.1.1 F29 (P44, D-F26-3 reversed): the hosts the person named in any of their own messages of the root's mission
   * window, those sent after the mode came on included, read now. Empty while the root has no consent list. Only the
   * person's typed text is read (`MissionWindow.personText`): an agent's or a tool's message, or a file, names nothing.
   */
  readonly missionHosts: (root: SessionID) => Effect.Effect<readonly OutwardKnown.Destination[]>
  /**
   * A person allows items of the list they saw, named by its hash. Only the server's password route may call this: an
   * agent never reaches it. Each item counts once its own line is written, and a line that fails allows nothing more.
   */
  readonly allowConsent: (input: {
    readonly root: SessionID
    readonly hash: string
    readonly ids: readonly string[]
  }) => Effect.Effect<Consent, WriteError | ConsentError>
  /**
   * The consent behind the scope that decides this root's mode, or undefined: off, switched on without it, or a restart
   * since. The session's own answer wins over its folder's, as for the mode itself.
   */
  readonly bypassOf: (input: Where) => Effect.Effect<Bypass | undefined>
  /** The one hook told when a consented run ends, whichever way it ends. The last registration wins. */
  readonly onRunEnded: (hook: (run: EndedRun) => Effect.Effect<void>) => Effect.Effect<void>
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

/**
 * The recorder `Archive.move` takes (row 150), on the root's own chain. The archive module stays free of this file, and
 * the session folder is added here so the moved paths are masked as a pattern is. A line that fails rejects, and the move
 * reports it as not recorded.
 */
export const archiveRecorder = (record: Interface["record"], where: Where) => (line: Archive.ArchivedLine) =>
  Effect.runPromise(record(where.root, { ...line, directory: where.directory }))

/**
 * 1.2.6 row 37b: the recorder `ActionCheckpoint.create` takes, on the root's own chain, as `archiveRecorder` is for the
 * archive. The line is written after the manifest exists and before the call runs.
 */
export const checkpointRecorder = (record: Interface["record"], where: Where) => (line: ActionCheckpoint.CheckpointedLine) =>
  Effect.runPromise(record(where.root, { ...line, directory: where.directory }))

/**
 * 1.2.6 row 37b: where the mode is on for this session's root, with its service, for a tool that saves a checkpoint before
 * it writes (edit, write). Undefined when the mode is off or the services are not there; nothing changes then.
 */
export const activeFor = Effect.fnUntraced(function* (
  sessions: Parameters<typeof placeOf>[0] | undefined,
  sessionID: SessionID,
) {
  const autonomy = yield* Effect.serviceOption(Service)
  if (Option.isNone(autonomy) || sessions === undefined) return undefined
  const place = yield* placeOf(sessions, sessionID)
  const where = { root: place.root.id, directory: place.directory }
  if (!(yield* autonomy.value.isOn(where).pipe(Effect.catchCause(() => Effect.succeed(false))))) return undefined
  return { where, autonomy: autonomy.value }
})

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
      archive: entry.archive && ProjectTrust.printable(entry.archive, MAX_NAME),
      moved: entry.moved?.slice(0, MAX_MOVED).map((item) => ({
        from: ProjectTrust.printable(hide(item.from, entry.directory ?? "", MAX_MOVED_PATH), MAX_MOVED_PATH),
        to: ProjectTrust.printable(hide(item.to, entry.directory ?? "", MAX_MOVED_PATH), MAX_MOVED_PATH),
      })),
      bytes: entry.bytes,
      // 1.2.6 row 37b: only on `checkpointed`. The schema checks the id's and the sha's shape; counts are numbers.
      checkpoint: entry.checkpoint,
      entries: entry.entries,
      refs: entry.refs,
      manifestSha256: entry.manifestSha256,
    }
  if (entry.type === "marker")
    return {
      type: entry.type,
      rootID: ProjectTrust.printable(root, MAX_NAME),
      directory: entry.directory && ProjectTrust.printable(entry.directory, MAX_DIRECTORY),
      marker: entry.marker,
      files: entry.files,
      consentID: entry.consentID && ProjectTrust.printable(entry.consentID, MAX_NAME),
      hash: entry.hash,
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
    bypassed: entry.bypassed,
    via: entry.via,
    duplicateOf: entry.duplicateOf && ProjectTrust.printable(entry.duplicateOf, MAX_NAME),
    consentID: entry.consentID && ProjectTrust.printable(entry.consentID, MAX_NAME),
    destination: entry.destination && ProjectTrust.printable(entry.destination, MAX_PATTERN),
    attempts: entry.attempts,
    script: entry.script && {
      bytes: entry.script.bytes,
      sha: entry.script.sha,
      flags: entry.script.flags.slice(0, MAX_FLAGS).map((flag) => ProjectTrust.printable(flag, MAX_NAME)),
    },
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
  if (short.type === "outcome" && short.moved && short.moved.length > 0)
    return [
      { ...short, moved: short.moved.slice(0, Math.ceil(short.moved.length / 2)) },
      { ...short, moved: [] },
    ]
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
      // A call that matched one already held points at that entry: one entry, however many times it was asked (row 120).
      line.via !== "duplicate" &&
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
    // Per root: when its mode came on, its consent list, and the scan making one. All memory, so a restart starts over.
    const onSince = new Map<string, number>()
    // 1.1.1 F30 (P46, CR12-5, G12-P1): the person's hosts per root, read incrementally: the 3 nearest of their messages up
    // to the switch once, then at each call only the messages stored since the last one read. Cleared with the consent.
    // 1.1.1 F36 (CR14-3): `anchor` is the message ID of the row at `cursor` when the cursor was set (undefined: no row there).
    const missions = new Map<
      string,
      { consentID: string; since: number; cursor: number; anchor: string | undefined; hosts: Set<string> }
    >()
    const consents = new Map<string, Consent>()
    const scans = new Map<string, Deferred.Deferred<void>>()
    const cleared = new Set<string>()
    const scanScope = yield* Scope.Scope
    // What can still go on, across every open folder: SessionStatus and the prompts each keep theirs per folder.
    const running = new Map<string, string | undefined>()
    const prompts = new Map<string, { sessionID: string; directory: string | undefined }>()
    // Sessions that went idle since the last look. A root nothing happened to since a restart stays quiet until it runs.
    const idled = new Set<string>()
    // Per root, the held calls a b1 already named. Saying the same again adds nothing anyone can act on.
    const told = new Map<string, ReadonlySet<string>>()
    let lastIdle = 0
    // 1.1.1 (S1.2, S1.40): the consent per scope, keyed `session:<root>` or `directory:<folder>`, and the consented runs
    // per root. Memory only, never written and never read back from a file (AU-23): a restart starts with neither.
    const bypass = new Map<string, Bypass>()
    const runs = new Map<string, { root: SessionID; directory: string; since: number; language: ReportLanguage }>()
    let runEnded: ((run: EndedRun) => Effect.Effect<void>) | undefined

    const started = yield* Clock.currentTimeMillis
    yield* Effect.try({ try: () => sweepAudit(started), catch: String }).pipe(
      // A folder that is not there yet has nothing old in it.
      Effect.catch((error) =>
        error.includes("ENOENT") ? Effect.void : Effect.logError("could not sweep old audit files", { error }),
      ),
    )

    const isOnNow = (input: Where) => mode.sessions.get(input.root) ?? mode.directories.has(input.directory)

    // The same precedence as `isOnNow`: a session with an answer of its own goes by its own consent only.
    const bypassNow = (input: Where) => {
      if (!isOnNow(input)) return undefined
      return mode.sessions.has(input.root)
        ? bypass.get(`session:${input.root}`)
        : bypass.get(`directory:${input.directory}`)
    }

    // The run is gone from memory before the hook runs, so a hook that is slow or fails cannot end it twice.
    const endRun = Effect.fnUntraced(function* (root: string) {
      const run = runs.get(root)
      if (!run) return
      runs.delete(root)
      const until = yield* Clock.currentTimeMillis
      const ended: EndedRun = {
        root: run.root,
        directory: run.directory,
        since: run.since,
        until,
        language: run.language,
      }
      const hook = runEnded
      if (!hook) return yield* Effect.logWarning("autonomous run ended with no report hook", { root })
      yield* Effect.suspend(() => hook(ended)).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) => Effect.logError("the end of an autonomous run could not be reported", { root, cause }),
        ),
        Effect.forkIn(scanScope),
      )
    })

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

    // What the root's own file last said, for a process that has not marked it yet. A restart must not mark the mode
    // again, or the mission would start at the restart and not at the switch.
    const markedInFile = (id: string) => {
      const modes = verifyAudit(readAuditText(auditFile(id)), undefined).lines.flatMap((line) =>
        line.type === "marker" && (line.marker === "mode_on" || line.marker === "mode_off") ? [line] : [],
      )
      const run = modes.slice(modes.findLastIndex((line) => line.marker === "mode_off") + 1)
      return { on: run.length > 0, since: run[0]?.at }
    }

    const markMode = Effect.fn("Autonomy.markMode")(function* (input: Where) {
      const id = path.basename(input.root)
      const on = isOnNow(input)
      const known = modeMarked.get(input.root)
      const last =
        known ??
        (yield* Effect.try({ try: () => markedInFile(id), catch: String }).pipe(
          Effect.tap((found) => Effect.sync(() => found.since !== undefined && onSince.set(id, found.since))),
          Effect.map((found) => found.on),
          // An unreadable file says nothing, and the mark below is written as it was before.
          Effect.catch(() => Effect.succeed(false)),
        ))
      if (known === undefined && on === last) modeMarked.set(input.root, on)
      if (on !== last)
        yield* record(input.root, {
          type: "marker",
          directory: input.directory,
          marker: on ? "mode_on" : "mode_off",
          decidedBy: "system:mode_change",
        }).pipe(
          Effect.tap(() => Effect.sync(() => modeMarked.set(input.root, on))),
          Effect.tap(() =>
            on ? Clock.currentTimeMillis.pipe(Effect.map((now) => onSince.set(id, now))) : Effect.void,
          ),
          // Logged by record, and the next request tries again.
          Effect.ignore,
        )
      // S1.40-S1.41: a run ends once its consent is gone (mode_off just above, or consent taken away), and a root that is
      // on with consent and has no run starts one, with its marker written once.
      const consented = bypassNow(input)
      if (!consented) yield* endRun(input.root)
      if (on && consented && !runs.has(input.root)) {
        runs.set(input.root, {
          root: input.root,
          directory: input.directory,
          since: consented.at,
          language: consented.language,
        })
        yield* record(input.root, {
          type: "marker",
          directory: input.directory,
          marker: "bypass_on",
          decidedBy: "person",
        }).pipe(Effect.ignore)
      }
      if (!on) return yield* clearConsent(input)
      yield* identify(input)
    })

    const clearConsent = Effect.fnUntraced(function* (input: Where) {
      const id = path.basename(input.root)
      const had = consents.get(id)
      consents.delete(id)
      scans.delete(id)
      onSince.delete(id)
      missions.delete(id)
      if (!had && !cleared.has(id)) return
      cleared.delete(id)
      yield* record(input.root, {
        type: "marker",
        directory: input.directory,
        marker: "consent_cleared",
        consentID: had?.id,
        decidedBy: "system:mode_change",
      }).pipe(Effect.ignore)
    })

    /**
     * The mission is known once the root has a person message while the mode is on (U13): right away when the mode came
     * on after one, otherwise with the first. The first request then waits for the list, so it is there before any call
     * runs. A root with no person message yet is looked at again on its next request.
     */
    const identify = Effect.fnUntraced(function* (input: Where) {
      const id = path.basename(input.root)
      const running = scans.get(id)
      const done = running ?? (yield* Deferred.make<void>())
      if (!running) {
        if (!database) return
        scans.set(id, done)
        yield* scanMission(input, done).pipe(
          Effect.tap((found) => Effect.sync(() => !found && scans.delete(id))),
          Effect.catchCause((cause) => Effect.logError("could not make the consent list", { root: input.root, cause })),
          Effect.ensuring(Deferred.succeed(done, undefined)),
          Effect.forkIn(scanScope),
        )
      }
      yield* Deferred.await(done).pipe(Effect.timeout(CONSENT_WAIT_MS), Effect.ignore)
    })

    // False when the root has no person message yet. Only names are looked at, and only the person's own text is read.
    const scanMission = Effect.fnUntraced(function* (input: Where, running: Deferred.Deferred<void>) {
      const id = path.basename(input.root)
      if (!database) return false
      const { MessageV2 } = yield* Effect.promise(() => import("@/session/message-v2"))
      const messages = (yield* MessageV2.page({ sessionID: input.root, limit: MISSION_MESSAGES }).pipe(
        Effect.provideService(Database.Service, database),
      )).items
      const now = yield* Clock.currentTimeMillis
      const mission = MissionWindow.window(messages, { root: input.root, since: onSince.get(id) ?? now }).map(
        (entry) => entry.text,
      )
      if (mission.length === 0) return false
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die(new Error("no folder to scan"))
      const snapshot = yield* Effect.tryPromise(() => OutwardKnown.snapshot({ dir: input.directory })).pipe(
        Effect.tapError((error) => Effect.logError("could not take the destinations snapshot", { error })),
        Effect.option,
        Effect.map(Option.getOrUndefined),
      )
      const destinations = new Map(
        (snapshot ? OutwardKnown.named(snapshot, mission.join("\n")) : []).map(
          (destination) =>
            [
              `destination:${destination.kind}:${hashOf(JSON.stringify(destination)).slice(0, 12)}`,
              destination,
            ] as const,
        ),
      )
      const result = yield* Effect.promise(() =>
        ConsentScan.scan({
          // A root opened in another folder than the one serving it is scanned in its own.
          instance:
            instance.directory === input.directory
              ? instance
              : { ...instance, directory: input.directory, worktree: input.directory },
          mission,
          destinations: [...destinations].map(([key, destination]) => ({
            id: key.slice("destination:".length),
            label: OutwardKnown.label(destination),
            named: true,
          })),
        }),
      )
      // Still on, and still the same run: a switch off while this ran must not leave a list behind.
      if (!isOnNow(input) || scans.get(id) !== running) return true
      const consent: Consent = {
        id: `consent_${result.hash.slice(0, 16)}`,
        hash: result.hash,
        at: now,
        directory: input.directory,
        items: result.items,
        given: new Set(),
        stopped: result.stopped,
        dropped: result.dropped,
        snapshot,
        destinations,
      }
      consents.set(id, consent)
      if (snapshot && consent.items.length > 0)
        yield* record(input.root, {
          type: "marker",
          directory: input.directory,
          marker: "credential_snapshot",
          consentID: consent.id,
          decidedBy: "system:consent",
        }).pipe(Effect.ignore)
      if (consent.items.length > 0)
        yield* record(input.root, {
          type: "marker",
          directory: input.directory,
          marker: "consent_shown",
          consentID: consent.id,
          hash: consent.hash,
          decidedBy: "system:consent",
        }).pipe(Effect.ignore)
      return true
    })

    const consent = Effect.fn("Autonomy.consent")(function* (root: SessionID) {
      const running = scans.get(path.basename(root))
      if (running) yield* Deferred.await(running).pipe(Effect.timeout(CONSENT_WAIT_MS), Effect.ignore)
      return consents.get(path.basename(root))
    })


    /** Messages of `rows` with their parts, in the shape `MissionWindow.personText` reads. */
    const withParts = (rows: readonly (typeof MessageTable.$inferSelect)[]) =>
      Effect.gen(function* () {
        if (!database || rows.length === 0) return [] as SessionV1.WithParts[]
        missionCounters.hydrated += rows.length
        const parts = yield* database.db
          .select()
          .from(PartTable)
          .where(
            inArray(
              PartTable.message_id,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(PartTable.message_id, PartTable.id)
          .all()
          .pipe(Effect.orDie)
        const byMessage = new Map<string, unknown[]>()
        for (const part of parts) {
          const list = byMessage.get(part.message_id) ?? []
          list.push({ ...part.data, id: part.id, sessionID: part.session_id, messageID: part.message_id })
          byMessage.set(part.message_id, list)
        }
        return rows.map(
          (row) =>
            ({
              info: { ...row.data, id: row.id, sessionID: row.session_id },
              parts: byMessage.get(row.id) ?? [],
            }) as unknown as SessionV1.WithParts,
        )
      })

    // The row's stored sequence. SQLite keeps a row's `rowid` through `INSERT … ON CONFLICT DO UPDATE`.
    const MESSAGE_ROW = sql.raw(`"message"."rowid"`)
    const userRole = sql`json_extract(${MessageTable.data}, '$.role') = 'user'`

    const missionHosts = Effect.fn("Autonomy.missionHosts")(function* (root: SessionID) {
      const id = path.basename(root)
      const consent = consents.get(id)
      if (!database || !consent) return [] as OutwardKnown.Destination[]
      const db = database.db
      const now = yield* Clock.currentTimeMillis
      const since = onSince.get(id) ?? now
      let state = missions.get(id)
      // 1.1.1 F36 (CR14-3): SQLite hands the next row `max(rowid) + 1`, so when a revert removes the newest rows their
      // rowids come back, at or below the cursor, and the person's next message would never be read. A rowid at or below
      // the cursor can come back only once the row at the cursor is gone, so the read starts over from the switch when
      // that row is no longer the message it was, or when no row of the table reaches the cursor any more.
      if (state && state.consentID === consent.id && state.since === since) {
        // 1.1.1 F39 (G15-P1): the row at the cursor and the top rowid, in one statement.
        missionCounters.anchors++
        const [anchor] = yield* db
          .select({
            id: sql<string | null>`(select "id" from "message" where "rowid" = ${state.cursor})`,
            row: sql<number | null>`max(${MESSAGE_ROW})`,
          })
          .from(MessageTable)
          .all()
          .pipe(Effect.orDie)
        if ((anchor?.id ?? undefined) !== state.anchor || (anchor?.row ?? 0) < state.cursor) state = undefined
      }
      if (!state || state.consentID !== consent.id || state.since !== since) {
        // The 3 nearest of the person's messages up to the switch (MissionWindow.window's "before").
        const rows = yield* db
          .select()
          .from(MessageTable)
          .where(and(eq(MessageTable.session_id, root), lte(MessageTable.time_created, since + MISSION_SLACK_MS), userRole))
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .limit(MISSION_MESSAGES)
          .all()
          .pipe(Effect.orDie)
        missionCounters.rows += rows.length
        const before = (yield* withParts(rows))
          .filter((message) => message.info.time.created <= since)
          .flatMap((message) => {
            const text = MissionWindow.personText(message)
            return text ? [{ created: message.info.time.created, text }] : []
          })
          .toSorted((a, b) => a.created - b.created)
          .slice(-MissionWindow.MISSION_WINDOW)
        // 1.1.1 F33 (CR13-7): the cursor is the row's stored sequence (`rowid`, which an upsert keeps), not its time: a
        // message is stamped before it is stored, so a later-stamped row can be stored first. It starts before the first row
        // stamped within the slack before the switch, or after the last row stored when there is none.
        const [first] = yield* db
          .select({ row: sql<number | null>`min(${MESSAGE_ROW})` })
          .from(MessageTable)
          .where(and(eq(MessageTable.session_id, root), gt(MessageTable.time_created, since - MISSION_SLACK_MS)))
          .all()
          .pipe(Effect.orDie)
        const [last] = yield* db
          .select({ row: sql<number | null>`max(${MESSAGE_ROW})` })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, root))
          .all()
          .pipe(Effect.orDie)
        const cursor = first?.row != null ? first.row - 1 : (last?.row ?? 0)
        const [anchor] = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(sql`${MESSAGE_ROW} = ${cursor}`)
          .all()
          .pipe(Effect.orDie)
        state = {
          consentID: consent.id,
          since,
          cursor,
          anchor: anchor?.id as string | undefined,
          hosts: new Set(OutwardKnown.personHosts(before.map((entry) => entry.text).join("\n"))),
        }
        missions.set(id, state)
      }
      const current = state
      // Every message stored after the last one read, any role, in the order stored; only the person's are read in full.
      for (let page = 0; page < MISSION_PAGES; page++) {
        const fresh = yield* db
          .select({ id: MessageTable.id, row: sql<number>`${MESSAGE_ROW}`, time: MessageTable.time_created, user: userRole })
          .from(MessageTable)
          .where(and(eq(MessageTable.session_id, root), sql`${MESSAGE_ROW} > ${current.cursor}`))
          .orderBy(sql`${MESSAGE_ROW}`)
          .limit(MISSION_PAGE)
          .all()
          .pipe(Effect.orDie)
        missionCounters.rows += fresh.length
        const userIDs = fresh.filter((row) => Boolean(row.user)).map((row) => row.id)
        const full =
          userIDs.length === 0
            ? []
            : yield* db.select().from(MessageTable).where(inArray(MessageTable.id, userIDs)).all().pipe(Effect.orDie)
        const messages = new Map((yield* withParts(full)).map((message) => [message.info.id as string, message]))
        const texts: string[] = []
        let stopped = false
        for (const row of fresh) {
          const message = messages.get(row.id)
          // A message of the person's stored before its parts: read again at the next call. 1.1.1 F33 (CR13-8): only for a
          // while; one that still has no parts after that never gets them (an empty prompt, a crash between the two
          // writes) and is passed over, so it does not stop the read for the rest of the session.
          if (row.user && (!message || message.parts.length === 0) && row.time > now - PARTS_WAIT_MS) {
            stopped = true
            break
          }
          if (message && message.info.time.created > since) {
            const text = MissionWindow.personText(message)
            if (text) texts.push(text)
          }
          current.cursor = row.row
          current.anchor = row.id
        }
        for (const host of OutwardKnown.personHosts(texts.join("\n"))) current.hosts.add(host)
        if (stopped || fresh.length < MISSION_PAGE) break
      }
      return [...current.hosts].map((host): OutwardKnown.Destination => ({ kind: "host", host }))
    })

    const allowConsent = Effect.fn("Autonomy.allowConsent")(function* (input: {
      readonly root: SessionID
      readonly hash: string
      readonly ids: readonly string[]
    }) {
      const id = path.basename(input.root)
      const current = consents.get(id)
      if (!current || current.hash !== input.hash)
        return yield* new ConsentError({ message: "This list is no longer the one on show" })
      const given = new Set(current.given)
      const picked = current.items.filter((item) => input.ids.includes(item.id) && !given.has(item.id))
      yield* Effect.forEach(
        picked,
        (item) =>
          record(input.root, {
            type: "decision",
            sessionID: input.root,
            requestID: current.id,
            agent: "person",
            directory: current.directory,
            permission: "autonomy_consent",
            patterns: [item.pattern],
            class: "A",
            category: "consented",
            consentID: item.id,
            canUndo: false,
            decidedBy: "person",
            decision: "allow",
          }).pipe(
            // Each item is allowed with its own line, so the file never says less than memory does.
            Effect.tap(() => Effect.sync(() => given.add(item.id))),
            Effect.ensuring(Effect.sync(() => consents.set(id, { ...current, given: new Set(given) }))),
          ),
        { discard: true },
      )
      if (picked.length > 0)
        yield* record(input.root, {
          type: "marker",
          directory: current.directory,
          marker: "consent_given",
          consentID: current.id,
          hash: current.hash,
          decidedBy: "person",
        }).pipe(Effect.ignore)
      return consents.get(id) ?? current
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

    // S1.41(b): every run whose consent this change took away ends now. A root that went off gets its mode_off marker now
    // (markMode ends the run after it); one still on without consent only ends its run.
    const endStaleRuns = Effect.fnUntraced(function* () {
      yield* Effect.forEach(
        [...runs.values()].filter((run) => !bypassNow(run)),
        Effect.fnUntraced(function* (run) {
          if (!isOnNow(run)) yield* markMode({ root: run.root, directory: run.directory })
          yield* endRun(run.root)
        }),
        { discard: true },
      )
    })

    const setMode = Effect.fn("Autonomy.setMode")(function* (input: ModeChange) {
      const key = input.scope === "session" ? `session:${input.root}` : `directory:${input.directory}`
      const consented = input.on && input.bypassConsent === BYPASS_CONSENT
      // Start the script reader now, so the first consented tool call does not pay for it (1.1.1 F12a, Perf P4).
      if (consented) ScriptReader.warm()
      // Taken away before the write: off is honoured whatever happens to the file, and on without consent never keeps one.
      if (!consented) bypass.delete(key)
      const now = yield* Clock.currentTimeMillis
      yield* Effect.try({
        try: () => {
          // Before the write replaces it: a change nobody has looked at yet must not vanish under this one.
          observe()
          const next = withChange(mode, input)
          // Stopping is honoured whatever happens to the file. Starting without a saved answer is not started.
          if (!input.on) mode = next
          // A list goes with the mode at once, and its marker with the root's next mark.
          if (!input.on)
            consents.forEach((item, id) => {
              if (isOnNow({ root: id as SessionID, directory: item.directory })) return
              consents.delete(id)
              cleared.add(id)
            })
          seen[MODE_FILE] = writeMode(next)
          mode = next
        },
        catch: String,
      }).pipe(
        // Only once the mode is saved on: a switch that did not take gives no consent.
        Effect.tap(() =>
          Effect.sync(() => consented && bypass.set(key, { at: now, language: input.reportLanguage ?? "en" })),
        ),
        Effect.tapError((error) => Effect.logError("could not save the autonomous mode", { input, error })),
        Effect.mapError(() => new WriteError({ message: "Could not save the autonomous mode" })),
        Effect.ensuring(endStaleRuns()),
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
      modeSince: (root) => Effect.sync(() => onSince.get(path.basename(root))),
      consent,
      missionHosts: (root) =>
        missionHosts(root).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("could not read the mission's hosts", { root, cause }).pipe(Effect.as([] as OutwardKnown.Destination[])),
          ),
        ),
      allowConsent,
      bypassOf: (input) => Effect.sync(() => bypassNow(input)),
      onRunEnded: (hook) =>
        Effect.sync(() => {
          runEnded = hook
        }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [EventV2.node, Database.node] })

export * as Autonomy from "./autonomy"
