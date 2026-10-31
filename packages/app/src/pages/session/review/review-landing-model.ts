import { findClaims, type Brief, type BriefFile, type CheckKind, type EvidenceRow } from "./review-brief-model"

// Getting reviewed work into git and telling the team: everything said about what ran comes from the record of the run,
// never from the agent or a model, so a commit message cannot claim a test run that did not happen.

const MAX_SUBJECT = 72
const MAX_PROMPT = 160
const MAX_PROMPTS = 3

/** What goes in unless the person says otherwise: what they accepted, and what nothing argues against. */
export function includedByDefault(file: Pick<BriefFile, "mark" | "group" | "flags">) {
  if (file.mark === "ok") return true
  if (file.mark === "work" || file.mark === "changed") return false
  if (file.group === "elsewhere") return false
  return !file.flags.some((flag) => flag.severity === "high")
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

function cut(text: string, max: number) {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(" ")
  return `${space > max / 2 ? head.slice(0, space) : head}…`
}

/** The prompts that caused these files to change, oldest first. A correction along the way is part of the reason. */
export function promptsBehind(files: readonly Pick<BriefFile, "touches">[]) {
  const seen = new Set<string>()
  return files
    .flatMap((file) => file.touches)
    .toSorted((a, b) => a.at - b.at)
    .flatMap((touch) => {
      const prompt = touch.prompt ? oneLine(touch.prompt) : ""
      if (!prompt || seen.has(prompt)) return []
      seen.add(prompt)
      return [prompt]
    })
}

export type CheckWords = {
  passed: (command: string) => string
  stale: (command: string, count: number) => string
  failed: (command: string, exit: string) => string
  hidden: (command: string) => string
  partial: (command: string) => string
  none: (kinds: readonly CheckKind[]) => string
}

/** One line per check. Files outside this commit changing after a run say nothing about what this commit contains. */
export function checkLines(evidence: readonly EvidenceRow[], included: ReadonlySet<string>, words: CheckWords) {
  return evidence.flatMap((row) => {
    if (row.type === "none") return [words.none(row.kinds)]
    if (row.type !== "check") return []
    const command = row.run.command
    if (row.status === "failed") return [words.failed(command, String(row.run.exit ?? "?"))]
    if (row.status === "hidden") return [words.hidden(command)]
    if (row.status === "running") return []
    const after = row.editedAfter.filter((file) => included.has(file)).length
    if (after > 0) return [words.stale(command, after)]
    return [row.run.partial ? words.partial(command) : words.passed(command)]
  })
}

export type MessageWords = {
  asked: string
  checks: string
  mixed: string
  leftOut: (files: string) => string
  provenance: (reviewed: number, total: number) => string
}

export function composeMessage(input: {
  brief: Pick<Brief, "evidence" | "files">
  included: ReadonlySet<string>
  title?: string
  written?: { subject?: string; summary?: string }
  checks: CheckWords
  words: MessageWords
}) {
  const files = input.brief.files.filter((file) => input.included.has(file.file))
  const prompts = promptsBehind(files)
  // A model may be asked not to talk about tests, but only the record can be trusted to say what ran.
  const written = trustworthy(input.written)
  const subject = written?.subject ?? cut(input.title?.trim() || oneLine(prompts[0] ?? ""), MAX_SUBJECT)
  // The subject is often the prompt itself, and saying it twice tells nobody anything.
  const asked = prompts.slice(-MAX_PROMPTS).filter((prompt) => cut(prompt, MAX_SUBJECT) !== subject)
  const reason = written?.summary
    ? [written.summary]
    : asked.length > 0
      ? [input.words.asked, ...asked.map((prompt) => `- ${cut(prompt, MAX_PROMPT)}`)]
      : []
  const leftOut = input.brief.files.filter((file) => !input.included.has(file.file))
  const lines = checkLines(input.brief.evidence, input.included, input.checks)
  const fromRun = leftOut.filter((file) => file.group !== "elsewhere").map((file) => file.file)
  const checks =
    lines.length > 0
      ? [input.words.checks, ...lines.map((line) => `- ${line}`), ...(leftOut.length > 0 ? [input.words.mixed] : [])]
      : []
  const closing = [
    ...(fromRun.length > 0 ? [input.words.leftOut(fromRun.join(", "))] : []),
    input.words.provenance(files.filter((file) => file.mark === "ok").length, files.length),
  ]
  return [[subject], reason, checks, closing]
    .filter((section) => section.length > 0)
    .map((section) => section.join("\n"))
    .join("\n\n")
}

function trustworthy(written: { subject?: string; summary?: string } | undefined) {
  if (!written?.subject) return undefined
  return findClaims(`${written.subject}\n${written.summary ?? ""}`).length > 0 ? undefined : written
}

/** What to paste to a colleague: where it is, and the message exactly as committed, edits included. */
export function teamUpdate(input: { headline: string; message: string }) {
  return `${input.headline}\n\n${input.message.trim()}`
}
