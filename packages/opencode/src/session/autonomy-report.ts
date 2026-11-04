import fs, { chmodSync, constants as fsConstants, mkdirSync, writeFileSync } from "node:fs"
import { open as openFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Option } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Autonomy } from "@/permission/autonomy"
import { Secrets } from "@/tool/secrets"
import { MissionWindow } from "@/permission/mission-window"
import type { AutonomyTable } from "@/permission/autonomy-table"
import { BypassScreen } from "@/permission/bypass-screen"
import { OutwardConsent } from "@/permission/outward-consent"
import { ScriptReader } from "@/permission/script-reader"
import { Reach } from "@/tool/reach"
import { AutonomyReportTexts } from "./autonomy-report-texts"
import { SessionPrompt } from "./prompt"
import type { SessionID } from "./schema"
import { Session } from "./session"
import { SessionSummary } from "./summary"
import { Todo } from "./todo"

// The end report of an autonomous run the person consented to (1.1.1, S1.50-S1.62): a fairly detailed resume of what was
// done and decided, written from the record and never by a model. It is a file under the app's state folder, and a
// message in the root session that carries it and every report document the run made or was asked for (P3). Nothing in
// that message reaches a model: its text is `ignored`, and `message-v2.ts` leaves the whole message out.

export const MAX_DOCUMENTS = 10
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
/** What one report message may carry in all (code review m5); the largest documents are left out first. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024
// Kept inside the total for the report file itself, which is bounded by the row caps below and stays far under this.
const REPORT_RESERVE = 1024 * 1024
/** How many of the main agent's decisions the report names one by one (verifier M3); the rest are counted. */
export const MAX_DECISIONS = 50
/** How many outward actions the report names one by one (P42); the rest are counted. */
export const MAX_OUTWARD = 100
const MAX_CALL = 120
const MAX_DESTINATION = 120
const MAX_REASON = 200
const MAX_GOAL = 500
const MAX_RESULT = 4000
const MAX_ROWS = 200
const MAX_ITEM = 300

const MIMES: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
const REPORT_NAME = /(report|laporan|summary|ringkasan|resume|rangkuman)/i
const REPORT_SEGMENTS = new Set(["docs", "doc", "report", "reports", "laporan"])
// A path the person named in their goal: a run of non-space characters ending in one of the extensions above.
const NAMED_FILE = /[^\s"'`<>()[\]{},;]+\.(?:md|docx|pdf|xlsx|pptx)\b/gi
const EDIT_PERMISSIONS = new Set(["edit", "write", "patch", "multiedit"])

type Line = Autonomy.AuditLine
type DecisionLine = Extract<Line, { type: "decision" }>
type OutcomeLine = Extract<Line, { type: "outcome" }>
type MarkerLine = Extract<Line, { type: "marker" }>

/** Why a document the run made or was asked for is listed and not attached. */
export type NotAttached = "too_large" | "too_many" | "over_total" | "outside" | "link"

export interface Document {
  readonly file: string
  readonly bytes: number
  readonly reason?: NotAttached
}

/** Where a run's report is kept: never in the project folder, which the agent writes and the person may share. */
export const folderOf = (root: string) => path.join(Global.Path.state, "autonomy", "reports", root)

/** `YYYYMMDD-HHmmss` in local time. */
export function stamp(ms: number) {
  const date = new Date(ms)
  const two = (value: number) => String(value).padStart(2, "0")
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  )
}

/** Local ISO time with its offset, as the person reads a clock. */
export function localIso(ms: number) {
  const date = new Date(ms)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const two = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, "0")
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19)
  return `${local}${sign}${two(offset / 60)}:${two(offset % 60)}`
}

// A cut never ends inside a mask: `[hidden:github…` would read as if part of the value were shown.
const whole = (text: string) => {
  const start = text.lastIndexOf("[hidden:")
  return start >= 0 && text.indexOf("]", start) < 0 ? text.slice(0, start).trimEnd() : text
}

/**
 * Text that may hold a secret, for the report. The order matters (code review M2): secrets are masked on the WHOLE text
 * first, so a multi-line private key is seen as one block and a token is never shortened below its pattern by the cut;
 * then the masked text is cut to the limit; then each line is made printable, so a Markdown block keeps its lines. The
 * same three steps as `Autonomy.hide`, which collapses newlines and so cannot be used here as is.
 */
export function hidden(text: string, directory: string, limit = Number.POSITIVE_INFINITY) {
  const masked = Secrets.scrub(Secrets.scrubText(text), directory)
  const cut = masked.length > limit ? `${whole(masked.slice(0, limit - 1)).toWellFormed()}…` : masked
  return cut
    .split("\n")
    .map((line) => ProjectTrust.printable(line))
    .join("\n")
}

const kindOf = (permission: string) => {
  if (permission === "bash") return "commands" as const
  if (EDIT_PERMISSIONS.has(permission)) return "edits" as const
  if (["read", "glob", "grep", "list", "lsp"].includes(permission)) return "reads" as const
  if (["webfetch", "websearch", "codesearch"].includes(permission)) return "web" as const
  return "other" as const
}

const byMainAgent = (line: DecisionLine) =>
  line.via === "main_agent" || line.via === "for_subagent" || line.decidedBy.startsWith("agent:main/")

const deciderOf = (line: DecisionLine) => {
  if (line.via === "for_subagent")
    return line.decision === "allow" ? ("forSubagentsAllowed" as const) : ("forSubagentsDeclined" as const)
  if (byMainAgent(line)) return "main" as const
  if (line.decidedBy === "person") return "person" as const
  return "rules" as const
}

export type OutwardKind = "request" | "git_push" | "publish" | "image_push" | "deploy" | "other"

/**
 * Where a destination was not named on the command: a push to the branch's upstream, a publish to the registry the tool
 * is set to use. The report says so in words rather than guessing a name the configuration may change.
 */
export type Unnamed = { readonly upstream: true } | { readonly registryOf: string }

export interface Outward {
  readonly kind: OutwardKind
  readonly destination?: string | Unnamed
}

/**
 * 1.1.1 F34 (CR13-9, G13-P2): what each decision line sent, worked out once when the facts are gathered (`sendsOf`), so
 * `render` reads no file and gives the same text whatever the machine holds when it runs. Keyed by the line itself.
 */
export type Sends = ReadonlyMap<DecisionLine, Outward>

const OUTWARD_CATEGORIES = new Set(["outward", "outward_not_in_mission"])
const PUBLISHERS = new Set([...OutwardConsent.NODE_PUBLISHERS, "cargo", "poetry", "uv", "twine"])
const IMAGE_TOOLS = new Set(["docker", "podman"])
// Leading words that only run the next one: `env A=1 npx vercel deploy` is a deploy, as the gate reads `npx vercel`.
const WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "npx", "bunx"])
const SEGMENTS = /&&|\|\||[;|\n]/

// Whether a decision line is an action that leaves the computer (P42) is told by `sendsOf`, the only entry point: the
// destination the gate recorded comes first; a line it did not record is read with the gate's own readers
// (`OutwardConsent.request`, `sendForm`, `pushWords`, `fetch`), and a call that runs a project script by name through the
// sends inside the script. A line the gate marked as outward and nothing here reads is kind `other`. Whatever is shown
// goes through `hidden()` afterwards.

/**
 * Every decision line's send, for `Facts.sends`, inside one `Reach.snapshotScope` so a manifest is read once however many
 * calls name its scripts (G13-P2). A bash text is read once per folder: a run repeats the same calls.
 */
export function sendsOf(lines: readonly DecisionLine[], directory: string): Sends {
  return Reach.snapshotScope(() => {
    const instance = { directory, worktree: directory } as AutonomyTable.Input["instance"]
    const reads = new Map<string, Outward | undefined>()
    const found = new Map<DecisionLine, Outward>()
    for (const line of lines) {
      if (line.via === "duplicate") continue
      const cwd = line.directory || directory
      const text = line.patterns.join(" ")
      const key = `${cwd}\0${text}`
      if (line.permission === "bash" && !reads.has(key))
        reads.set(key, readCommand(text, cwd) ?? readSteps(scriptsOfText(text, cwd, instance), cwd))
      const read =
        line.permission === "webfetch" ? readFetch(line.patterns) : line.permission === "bash" ? reads.get(key) : undefined
      const sent = sentFrom(line, read)
      if (sent) found.set(line, sent)
    }
    return found
  })
}

function sentFrom(line: DecisionLine, read: Outward | undefined): Outward | undefined {
  const marked =
    line.via === "outward" ||
    [line.category, line.bypassed].some((item) => item !== undefined && (OUTWARD_CATEGORIES.has(item) || item.startsWith("outward")))
  const recorded = recordedDestination(line)
  if (!read && !marked && recorded === undefined) return undefined
  return { kind: read?.kind ?? "other", destination: recorded ?? read?.destination ?? urlLabel(line.patterns) }
}

// The destination the gate wrote down: the line's `destination` field (F26, the effective target), then the `sent to …`
// reason the gate gives a ticked destination.
function recordedDestination(line: DecisionLine) {
  if (line.destination?.trim()) return line.destination.trim()
  if (line.reason?.startsWith("sent to ")) return line.reason.slice("sent to ".length).trim() || undefined
  return undefined
}

function readFetch(patterns: readonly string[]): Outward {
  const found = OutwardConsent.fetch(patterns[0], patterns.slice(0, 1), undefined)
  return { kind: "request", destination: "held" in found ? urlLabel(patterns) : found.destinations.join(", ") }
}

function readCommand(text: string, directory: string): Outward | undefined {
  return readSteps(text.split(SEGMENTS).map(words), directory)
}

/** The first step that sends, with every destination of the steps of its kind. */
function readSteps(steps: readonly (readonly string[])[] | undefined, directory: string): Outward | undefined {
  let first: Outward | undefined
  const named: string[] = []
  for (const argv of steps ?? []) {
    const found = readStep(argv, directory)
    if (!found || (first && found.kind !== first.kind)) continue
    first ??= found
    if (typeof found.destination === "string") named.push(found.destination)
  }
  if (!first) return undefined
  return named.length > 0 ? { kind: first.kind, destination: [...new Set(named)].join(", ") } : first
}

function readStep(all: readonly string[], directory: string): Outward | undefined {
  const start = all.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !WRAPPERS.has(word))
  if (start < 0) return undefined
  const name = path.basename(all[start]!)
  const args = all.slice(start + 1)
  if (name === "git") return readGit(args)
  if (OutwardConsent.REQUEST_TOOLS.has(name)) {
    const found = OutwardConsent.request(name, args, undefined, "")
    const destination = found && !("held" in found) ? found.destinations.join(", ") : urlLabel(args)
    return { kind: "request", destination }
  }
  // 1.1.1 F34 (G13-P2): a publish is told by its subcommand alone, as `sendForm` tells it, and never read further: what
  // registry the tool is set to use lives in configuration files (`.npmrc`, `~/.npmrc`, `.cargo/config.toml`), and the
  // report does not guess it. A line the gate opened carries the registry it recorded (`sentFrom`); otherwise the
  // registry named on the command, or the words "the registry npm is set to use".
  if (PUBLISHERS.has(name)) {
    if (!publishes(name, args)) return undefined
    return { kind: "publish", destination: registryNamed(name, args) ?? { registryOf: name } }
  }
  const found = OutwardConsent.sendForm(name, args, directory)
  if (!found) return undefined
  const kind: OutwardKind = IMAGE_TOOLS.has(name) ? "image_push" : "deploy"
  if ("held" in found) return { kind }
  return { kind, destination: found.destinations.join(", ") }
}

// The subcommands `OutwardConsent.sendForm` reads as a publish, by its positional words (those not starting with `-`).
function publishes(name: string, args: readonly string[]) {
  const [first, second] = args.filter((word) => !word.startsWith("-"))
  if (name === "twine") return first === "upload"
  if (name === "yarn" && first === "npm") return second === "publish"
  return first === "publish"
}

// An option of a publish that sets where it goes: the host of a URL value, or the value as written (a registry name).
// `-r` names a registry only for poetry and twine; for pnpm it means recursive, and npm has no such option (CR14-6).
const REGISTRY_OPTION = /^(--registry|--index|--repository|--repository-url|--publish-url)(=(.*))?$/
const REGISTRY_SHORT = /^(-r)(=(.*))?$/
function registryNamed(name: string, args: readonly string[]) {
  for (const [index, word] of args.entries()) {
    const match = REGISTRY_OPTION.exec(word) ?? (name === "poetry" || name === "twine" ? REGISTRY_SHORT.exec(word) : null)
    if (!match) continue
    const value = (match[2] ? match[3] : args[index + 1])?.trim()
    if (!value) return undefined
    const url = value.includes("://") ? OutwardConsent.urlOf(value) : undefined
    return url ? OutwardConsent.label(url) : value
  }
  return undefined
}

function readGit(args: readonly string[]): Outward | undefined {
  // `git -C dir -c k=v push …`: the options before the subcommand take a value each.
  let index = 0
  while (index < args.length && args[index]!.startsWith("-")) index += args[index] === "-C" || args[index] === "-c" ? 2 : 1
  if (args[index] !== "push") return undefined
  const argv = ["git", "push", ...args.slice(index + 1)]
  // The gate's reading of a push it opens: the remote, or "" for the branch's upstream.
  const remote = OutwardConsent.pushWords(argv)
  if (remote === "") return { kind: "git_push", destination: { upstream: true } }
  if (remote !== undefined) return { kind: "git_push", destination: remote }
  // 1.1.1 F34 (V13-1): one it does not open (force, `--repo`, a folder, a URL, an option it does not know) shows the
  // repository as written in the call, as the gate's refusal reads it (`pushRepositories`): never a branch, `.` or "".
  const all = OutwardConsent.pushRepositories(argv) ?? []
  if (all.length === 0) return { kind: "git_push", destination: { upstream: true } }
  // With `--repo` the words after the options are refspecs (`git push --repo=../other main` pushes `main` there); the
  // gate checks them all, the report names the repository git uses. `pushRepositories` lists the `--repo` values first.
  const repos = argv.filter((word) => /^--repo?(=|$)/.test(word)).length
  const written = [...new Set(all.slice(0, repos || all.length).map(writtenPlace).filter(Boolean))]
  return { kind: "git_push", destination: written.length > 0 ? written.join(", ") : undefined }
}

// A repository word as written, without the account part of a URL (`https://user:token@host/…`).
const writtenPlace = (word: string) => word.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1")

/** `host[:port]` of the first word a request tool reads as a URL with a host (never its account or path), as the gate labels it. */
function urlLabel(args: readonly string[]) {
  for (const word of args.flatMap((item) => words(item))) {
    const url = OutwardConsent.urlOf(word)
    if (url && (word.includes("://") || /[.:]/.test(url.host) || url.hostname === "localhost")) return OutwardConsent.label(url)
  }
  return undefined
}

/** Words of a command, quotes taken off; good enough to find a program and its arguments for the gate's readers. */
function words(segment: string) {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "")
}

// The steps of the project scripts `text` runs by name; none when a script cannot be read (the line stays as marked).
function scriptsOfText(text: string, cwd: string, instance: AutonomyTable.Input["instance"]): (readonly string[])[] {
  try {
    return text
      .split(SEGMENTS)
      .map(words)
      .flatMap((argv) => BypassScreen.scriptSteps(argv, cwd, instance).map((step) => step.argv))
  } catch {
    return []
  }
}

const realOf = (file: string) => {
  try {
    return fs.realpathSync(file)
  } catch {
    return undefined
  }
}

const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** The folders a document may really sit in (security L2): the project folder and the report folder, links resolved. */
export function placesOf(directory: string, reportFolder?: string) {
  return [directory, reportFolder].flatMap((item) => {
    const real = item === undefined ? undefined : realOf(item)
    return real === undefined ? [] : [real]
  })
}

/**
 * Where a candidate stands. `lstat` first: a link in a document's place is not followed. Then `realpath`, which resolves
 * every component, so a linked folder on the way cannot carry a file from elsewhere into the message (security L2).
 */
function placeOf(file: string, places: readonly string[]) {
  const stat = (() => {
    try {
      return fs.lstatSync(file)
    } catch {
      return undefined
    }
  })()
  if (!stat) return undefined
  if (stat.isSymbolicLink()) return { bytes: stat.size, reason: "link" as const }
  if (!stat.isFile()) return undefined
  const real = realOf(file)
  if (real === undefined || !places.some((place) => within(place, real)))
    return { bytes: stat.size, reason: "outside" as const }
  return { bytes: stat.size, reason: undefined }
}

/** The report documents the run made or the person asked for, by S1.54. Existence is checked here, as late as it can be. */
export function documents(input: {
  readonly directory: string
  readonly decisions: readonly DecisionLine[]
  readonly changed: readonly string[]
  readonly goal: readonly string[]
  readonly exclude: string
  readonly reportFolder?: string
  /** For tests; the report message's own budget otherwise. */
  readonly budget?: number
}) {
  const candidates: string[] = []
  const resolve = (file: string) => (path.isAbsolute(file) ? path.normalize(file) : path.resolve(input.directory, file))
  for (const line of input.decisions)
    if (line.decision === "allow" && EDIT_PERMISSIONS.has(line.permission))
      for (const pattern of line.patterns) candidates.push(resolve(pattern))
  for (const file of input.changed) candidates.push(resolve(file))
  for (const text of input.goal)
    for (const match of text.matchAll(NAMED_FILE)) candidates.push(resolve(match[0].replace(/^@/, "")))

  const places = placesOf(input.directory, input.reportFolder)
  const kept: Document[] = []
  const skipped: Document[] = []
  const seen = new Set<string>([path.normalize(input.exclude)])
  for (const file of candidates) {
    if (seen.has(file)) continue
    seen.add(file)
    const extension = path.extname(file).toLowerCase()
    if (!MIMES[extension]) continue
    const segments = path.dirname(file).split(path.sep).map((segment) => segment.toLowerCase())
    if (!REPORT_NAME.test(path.basename(file)) && !segments.some((segment) => REPORT_SEGMENTS.has(segment))) continue
    const place = placeOf(file, places)
    if (!place) continue
    if (place.reason) skipped.push({ file, bytes: place.bytes, reason: place.reason })
    else if (place.bytes > MAX_DOCUMENT_BYTES) skipped.push({ file, bytes: place.bytes, reason: "too_large" })
    else if (kept.length < MAX_DOCUMENTS) kept.push({ file, bytes: place.bytes })
    else skipped.push({ file, bytes: place.bytes, reason: "too_many" })
  }

  // The total budget (code review m5): the largest go first, the others keep the order they were found in.
  const budget = input.budget ?? MAX_TOTAL_BYTES - REPORT_RESERVE
  const over = new Set<Document>()
  let total = kept.reduce((sum, item) => sum + item.bytes, 0)
  for (const item of kept.toSorted((a, b) => b.bytes - a.bytes)) {
    if (total <= budget) break
    over.add(item)
    total -= item.bytes
  }
  const attached = kept.filter((item) => !over.has(item))
  for (const item of kept) if (over.has(item)) skipped.push({ ...item, reason: "over_total" })
  return { attached, skipped }
}

/**
 * A document's bytes for the message, read off the server fiber. The place is checked again and the file is opened
 * without following a link, so a swap since `documents()` ran cannot bring in a file from elsewhere; a file that grew
 * past its limit is left out.
 */
async function readDocument(file: string, places: readonly string[], limit: number) {
  const place = placeOf(file, places)
  if (!place || place.reason) return undefined
  const handle = await openFile(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > Math.min(limit, MAX_DOCUMENT_BYTES)) return undefined
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

export interface Facts {
  readonly run: Autonomy.EndedRun
  readonly title?: string
  readonly agent?: string
  readonly lines: readonly Line[]
  readonly open: readonly DecisionLine[]
  readonly goal: readonly string[]
  readonly result?: string
  readonly files: readonly { file: string; additions: number; deletions: number }[]
  readonly todos: readonly { content: string; status: string }[]
  readonly attached: readonly Document[]
  readonly skipped: readonly Document[]
  /** What each decision line sent (`sendsOf`), worked out in the gather step; `render` reads no file. */
  readonly sends: Sends
}

export function counts(facts: Pick<Facts, "lines" | "open">) {
  const decisions = facts.lines.filter((line): line is DecisionLine => line.type === "decision")
  const outcomes = facts.lines.filter((line): line is OutcomeLine => line.type === "outcome")
  return {
    ran:
      decisions.filter((line) => line.decision === "allow").length +
      outcomes.filter((line) => line.outcome === "approved_later").length,
    main: decisions.filter(byMainAgent).length,
    refused: decisions.filter((line) => line.class === "X").length,
    waiting: facts.open.length,
  }
}

/**
 * The report as Markdown. Deterministic: the same facts give the same text. It reads no file (1.1.1 F34, CR13-9): every
 * file the report needs is read in the gather step (`sendsOf`, `documents`).
 */
export function render(facts: Facts) {
  const { run } = facts
  const texts = AutonomyReportTexts.TEXTS[run.language]
  const labels = AutonomyReportTexts.CATEGORY[run.language]
  const hide = (text: string, limit = MAX_ITEM) => hidden(text, run.directory, limit)
  const decisions = facts.lines.filter((line): line is DecisionLine => line.type === "decision")
  const outcomes = facts.lines.filter((line): line is OutcomeLine => line.type === "outcome")
  const markers = facts.lines.filter((line): line is MarkerLine => line.type === "marker")
  const call = (line: DecisionLine) => `\`${hide(`${line.permission} ${line.patterns.join(" ")}`).replaceAll("`", "'")}\``
  const list = (items: readonly string[]) =>
    items.length === 0
      ? [texts.none]
      : [
          ...items.slice(0, MAX_ROWS).map((item) => `- ${item}`),
          ...(items.length > MAX_ROWS ? [`- … (+${items.length - MAX_ROWS})`] : []),
        ]
  const section = (heading: string, body: readonly string[]) => ["", `## ${heading}`, "", ...body]

  const kinds = { commands: 0, edits: 0, reads: 0, web: 0, other: 0 }
  const deciders = { main: 0, person: 0, rules: 0, forSubagentsAllowed: 0, forSubagentsDeclined: 0 }
  for (const line of decisions) {
    kinds[kindOf(line.permission)]++
    deciders[deciderOf(line)]++
  }
  const total = counts(facts)

  const archived = outcomes
    .filter((line) => line.outcome === "archived")
    .flatMap((line) => (line.moved ?? []).map((item) => `\`${hide(item.from)}\` -> \`${hide(item.to)}\``))
  const refused = decisions
    .filter((line) => line.class === "X")
    .map((line) => `${call(line)}: ${line.category ? (labels[line.category] ?? line.category) : texts.none}`)
  // Each call the main agent decided (verifier M3, P3 "riwayat kerja"): when, which tool, what it asked, the category
  // it had before the consent changed it, the answer and why. Capped, with a count of the rest.
  const mainDecisions = decisions.filter(byMainAgent)
  const verdictOf = (line: DecisionLine) =>
    line.decision === "allow" ? texts.verdicts.allow : line.decision === "reject" ? texts.verdicts.reject : texts.verdicts.defer
  const decided = mainDecisions.slice(0, MAX_DECISIONS).map((line) => {
    const original = line.bypassed ?? line.category
    const label = original ? (labels[original] ?? original) : texts.none
    const short = `\`${hide(line.patterns.join(" "), MAX_CALL).replaceAll("`", "'")}\``
    const forWhom = line.via === "for_subagent" ? ` (${texts.forSubagent.replace("{agent}", hide(line.agent, 60))})` : ""
    const why = line.reason ? `: ${hide(line.reason, MAX_REASON)}` : ""
    return `${localIso(line.at).slice(0, 19).replace("T", " ")} · ${hide(line.permission, 40)} · ${short} · ${label} · ${verdictOf(line)}${forWhom}${why}`
  })
  const decisionRows =
    decided.length === 0
      ? [texts.none]
      : [
          ...decided.map((item) => `- ${item}`),
          ...(mainDecisions.length > MAX_DECISIONS
            ? [`- ${texts.more.replace("{n}", String(mainDecisions.length - MAX_DECISIONS))}`]
            : []),
        ]

  // Every action of the run that left the computer, or would have (P42): when, which tool, what kind, where to and what
  // became of it. A call held for a person and answered later says so. Capped, with a count of the rest.
  const later = new Map(
    outcomes
      .filter((line) => line.outcome === "approved_later" || line.outcome === "rejected_later")
      .map((line) => [line.requestID, line.outcome]),
  )
  const outward = decisions.flatMap((line) => {
    const found = facts.sends.get(line)
    return found ? [{ line, found }] : []
  })
  const sentRows = outward.slice(0, MAX_OUTWARD).map(({ line, found }) => {
    const answered = later.get(line.requestID)
    const verdict =
      line.decision === "allow"
        ? texts.outwardVerdicts.ran
        : line.decision === "reject"
          ? texts.outwardVerdicts.refused
          : answered === "approved_later"
            ? texts.outwardVerdicts.ranLater
            : answered === "rejected_later"
              ? texts.outwardVerdicts.refusedLater
              : texts.outwardVerdicts.waited
    const where =
      found.destination === undefined
        ? texts.unknownDestination
        : typeof found.destination === "string"
          ? `\`${hide(found.destination, MAX_DESTINATION).replaceAll("`", "'")}\``
          : "upstream" in found.destination
            ? texts.upstream
            : texts.defaultRegistry.replace("{tool}", found.destination.registryOf)
    const short = `\`${hide(line.patterns.join(" "), MAX_CALL).replaceAll("`", "'")}\``
    return `${localIso(line.at).slice(0, 19).replace("T", " ")} · ${hide(line.permission, 40)} · ${texts.outwardKinds[found.kind]} · ${where} · ${verdict} · ${short}`
  })
  const outwardRows =
    sentRows.length === 0
      ? [texts.none]
      : [
          ...sentRows.map((item) => `- ${item}`),
          ...(outward.length > MAX_OUTWARD ? [`- ${texts.more.replace("{n}", String(outward.length - MAX_OUTWARD))}`] : []),
        ]

  const issues = [
    ...outcomes.filter((line) => line.outcome === "failed").map((line) => `${texts.failed}: ${hide(line.requestID)}`),
    ...decisions
      .filter((line) => line.decidedBy === "system:main_agent_unavailable")
      .map((line) => `${texts.unavailable}: ${call(line)}`),
    ...decisions
      .filter((line) => line.category === "queue_full" || line.decidedBy === "system:queue_full")
      .map((line) => `${texts.queueFull}: ${call(line)}`),
    ...decisions.filter((line) => line.class === "B").map((line) => `${texts.stopped}: ${call(line)}`),
    ...markers.filter((line) => line.marker === "b0").map(() => texts.queueFull),
    ...markers.filter((line) => line.marker === "b1").map(() => texts.stopped),
  ]

  const lines = [
    `# ${texts.title}`,
    "",
    `- ${texts.session}: ${hide(facts.title ?? run.root)} (${run.root})`,
    `- ${texts.started}: ${localIso(run.since)}`,
    `- ${texts.ended}: ${localIso(run.until)}`,
    `- ${texts.agent}: ${hide(facts.agent ?? "build")}`,
    "",
    AutonomyReportTexts.summary(run.language, total).replace(/ [^.]*\.$/, ""),
    ...section(
      texts.goal,
      facts.goal.length === 0 ? [texts.none] : facts.goal.flatMap((text, index) => [...(index > 0 ? [""] : []), ...quote(hide(text, MAX_GOAL))]),
    ),
    ...section(texts.result, facts.result ? quote(hide(facts.result, MAX_RESULT)) : [texts.none]),
    ...section(texts.done, [
      `### ${texts.byKind}`,
      "",
      ...Object.entries(kinds).map(([key, value]) => `- ${texts.kinds[key as keyof typeof kinds]}: ${value}`),
      "",
      `### ${texts.byDecider}`,
      "",
      ...Object.entries(deciders).map(([key, value]) => `- ${texts.deciders[key as keyof typeof deciders]}: ${value}`),
    ]),
    ...section(texts.decisions, decisionRows),
    ...section(texts.outward, outwardRows),
    ...section(
      texts.files,
      list(facts.files.map((item) => `\`${hide(item.file)}\` (+${item.additions}, -${item.deletions})`)),
    ),
    ...section(texts.archived, list(archived)),
    ...section(texts.refused, list(refused)),
    ...section(texts.waiting, list(facts.open.map((line) => `${call(line)} (${hide(line.agent)})`))),
    ...section(
      texts.todos,
      list(facts.todos.map((todo) => `[${todo.status === "completed" ? "x" : " "}] ${hide(todo.content)}`)),
    ),
    ...section(texts.issues, list(issues)),
    ...section(texts.attached, [
      ...list(facts.attached.map((item) => `\`${hide(item.file, Number.POSITIVE_INFINITY)}\` (${item.bytes} B)`)),
      ...(facts.skipped.length > 0
        ? [
            "",
            `${texts.skipped}:`,
            ...facts.skipped.map(
              (item) =>
                `- \`${hide(item.file, Number.POSITIVE_INFINITY)}\` (${item.bytes} B)${item.reason ? `: ${texts.notAttached[item.reason]}` : ""}`,
            ),
          ]
        : []),
    ]),
    "",
  ]
  return lines.join("\n")
}

function quote(text: string) {
  return text.split("\n").map((line) => (line ? `> ${line}` : ">"))
}

const mimeOf = (file: string) => MIMES[path.extname(file).toLowerCase()] ?? "text/markdown"

/** Writes the report file: folders 0700, the file 0600, a new name if one of the same second is there already. */
function store(root: string, until: number, text: string) {
  const dir = folderOf(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (let index = 0; ; index++) {
    const file = path.join(dir, `${stamp(until)}${index === 0 ? "" : `-${index}`}-report.md`)
    try {
      writeFileSync(file, text, { mode: 0o600, flag: "wx" })
      chmodSync(file, 0o600)
      return file
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || index > 100) throw error
    }
  }
}

export const make = Effect.gen(function* () {
  const autonomy = yield* Autonomy.Service
  const sessions = yield* Session.Service
  // Optional as in `LateAnswer.make`: without them the report is shorter, or written and not posted, never lost.
  const prompt = Option.getOrUndefined(yield* Effect.serviceOption(SessionPrompt.Service))
  const summary = Option.getOrUndefined(yield* Effect.serviceOption(SessionSummary.Service))
  const todo = Option.getOrUndefined(yield* Effect.serviceOption(Todo.Service))

  const gather = Effect.fnUntraced(function* (run: Autonomy.EndedRun, exclude: string) {
    const info = yield* sessions.get(run.root).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    const messages = yield* sessions
      .messages({ sessionID: run.root })
      .pipe(Effect.catchCause(() => Effect.succeed([] as SessionV1.WithParts[])))
    const audit = yield* autonomy.readAudit(run.root)
    const lines = audit.lines.filter((line) => line.at >= run.since && line.at <= run.until)
    const open = (yield* autonomy.openDecisions()).filter((line) => line.rootID === run.root)
    const goal = MissionWindow.window(messages, { root: run.root, since: run.since }).map((entry) => entry.text)
    const mine = messages.filter((message) => message.info.sessionID === run.root)
    const agent = mine.findLast((message) => message.info.role === "user")?.info
    const last = mine.findLast(
      (message) => message.info.role === "assistant" && message.info.time.created >= run.since,
    )
    const result = last?.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
      .join("\n")
      .trim()

    // The files changed by the person's messages of the run, as their summaries keep them.
    const changed = new Map<string, { file: string; additions: number; deletions: number }>()
    for (const message of mine) {
      if (message.info.role !== "user" || message.info.time.created < run.since) continue
      const diffs = summary
        ? yield* summary
            .diff({ sessionID: run.root, messageID: message.info.id })
            .pipe(Effect.catchCause(() => Effect.succeed([])))
        : (message.info.summary?.diffs ?? [])
      for (const item of diffs) {
        if (!item.file) continue
        const before = changed.get(item.file)
        changed.set(item.file, {
          file: item.file,
          additions: (before?.additions ?? 0) + (item.additions ?? 0),
          deletions: (before?.deletions ?? 0) + (item.deletions ?? 0),
        })
      }
    }
    const files = [...changed.values()].toSorted((a, b) => a.file.localeCompare(b.file))
    const todos = todo ? yield* todo.get(run.root).pipe(Effect.catchCause(() => Effect.succeed([]))) : []
    // The script reader reads a project script as the gate's screen does; it never fails, it only may not start.
    yield* Effect.promise(() => ScriptReader.prepare())
    const found = documents({
      directory: run.directory,
      decisions: lines.filter((line): line is DecisionLine => line.type === "decision"),
      changed: files.map((item) => item.file),
      goal,
      exclude,
      reportFolder: folderOf(run.root),
    })
    const sends = sendsOf(
      lines.filter((line): line is DecisionLine => line.type === "decision"),
      run.directory,
    )
    // The project's secret files are read here, once, for the masks `render` applies (`Secrets.scrub` keeps them for a
    // few seconds), so the render that follows at once reads none.
    hidden("", run.directory)
    return {
      info,
      facts: {
        run,
        title: info?.title,
        agent: agent?.role === "user" ? agent.agent : undefined,
        lines,
        open,
        goal,
        result: result || undefined,
        files,
        todos,
        attached: found.attached,
        skipped: found.skipped,
        sends,
      } satisfies Facts,
    }
  })

  const write = Effect.fn("AutonomyReport.write")(function* (run: Autonomy.EndedRun) {
    // The name is fixed before anything is gathered, so the report never lists itself.
    const planned = path.join(folderOf(run.root), `${stamp(run.until)}-report.md`)
    const { info, facts } = yield* gather(run, planned)
    const text = render(facts)
    const file = yield* Effect.try({ try: () => store(run.root, run.until, text), catch: (error) => error })
    yield* Effect.logInfo("autonomous run report written", { root: run.root, file })

    if (!info || info.time.archived) {
      yield* Effect.logInfo("autonomous run report not posted: the session is archived or gone", { root: run.root })
      return
    }
    // Spec risk R-5: `prompt.prompt` runs `revert.cleanup` first, which would make a pending Undo final and lose its redo.
    // The file is kept and nothing is posted; the person finds it in the report folder named in the log line.
    if (info.revert) {
      yield* Effect.logInfo("autonomous run report not posted: an Undo is pending in the session, the file is kept", {
        root: run.root,
        file,
      })
      return
    }
    if (!prompt) {
      yield* Effect.logWarning("autonomous run report not posted: no session runner here", { root: run.root })
      return
    }
    const places = placesOf(run.directory, folderOf(run.root))
    // Read again as late as it can be, off the server fiber, inside the message's total (code review m5). A document that
    // went away, moved out of its place or grew past what is left of the total is left out, not the whole message.
    let left = MAX_TOTAL_BYTES
    const attach = (item: string) =>
      Effect.promise(() => readDocument(item, places, left).catch(() => undefined)).pipe(
        Effect.map((bytes) => {
          if (!bytes) return []
          left -= bytes.length
          return [
            {
              type: "file" as const,
              mime: mimeOf(item),
              filename: item,
              url: `data:${mimeOf(item)};base64,${bytes.toString("base64")}`,
            },
          ]
        }),
      )
    const own = yield* attach(file)
    if (own.length === 0) {
      yield* Effect.logWarning("autonomous run report not posted: the report file could not be read back", {
        root: run.root,
        file,
      })
      return
    }
    const others: (typeof own)[number][] = []
    for (const item of facts.attached) others.push(...(yield* attach(item.file)))
    const parts = [
      {
        type: "text" as const,
        text: AutonomyReportTexts.summary(run.language, counts(facts)),
        ignored: true,
        metadata: { autonomyReport: true },
      },
      ...own,
      ...others,
    ]
    // `noReply`: the message is for the person. The agent is not woken by it (`prompt.ts` returns before the loop).
    yield* prompt.prompt({ sessionID: run.root, agent: facts.agent, noReply: true, parts })
    yield* autonomy
      .record(run.root, { type: "marker", directory: run.directory, marker: "bypass_report", decidedBy: "system:report" })
      .pipe(Effect.catch((error) => Effect.logError("could not record the report marker", { root: run.root, error })))
  })

  return {
    write: (run: Autonomy.EndedRun) =>
      write(run).pipe(
        Effect.catchCause((cause) => Effect.logError("could not write the autonomous run report", { root: run.root, cause })),
      ),
  }
})

export * as AutonomyReport from "./autonomy-report"
