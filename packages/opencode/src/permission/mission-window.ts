import type { SessionV1 } from "@opencode-ai/core/v1/session"

// The mission (U13): what the person typed in the root session's last 3 messages when autonomous mode came on, and
// every message they send while it stays on. Rules 2, 3 and 9 read this and nothing else. A file the person attached,
// a tool's output, a skill, a late answer, a message the system wrote and a subagent's prompt are not the person.

export const MISSION_WINDOW = 3
export const QUOTE_MIN_CHARS = 12

/** Words that ask the agent to ask first (register U11). Matched as whole words, case does not matter. */
export const ASK_LEXICON = [
  "tanya",
  "tanyakan",
  "konfirmasi",
  "minta persetujuan",
  "tunggu saya",
  "jangan lanjut sebelum",
  "biar saya yang putuskan",
  "ask me",
  "check with me",
  "confirm with me",
  "wait for me",
  "let me decide",
] as const

export interface Entry {
  readonly messageID: string
  readonly created: number
  readonly text: string
}

/**
 * What the person typed in one message, or undefined when none of it is theirs.
 *
 * `@file` attachments arrive as file parts plus synthetic text (`session/prompt.ts` resolvePart), so they drop out by
 * type and flag. A `/cmd` template is stored as a plain text part (`session/prompt.ts` command, `resolvePromptParts`)
 * and carries no flag of its own: it counts only once that part says which command it came from in
 * `metadata.command`, and then only the arguments the person typed (`metadata.arguments`) are theirs.
 */
export function personText(message: SessionV1.WithParts) {
  if (message.info.role !== "user") return
  if (message.parts.some((part) => part.type === "compaction")) return
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [typed(part)] : []))
    .filter((piece): piece is string => !!piece)
    .join("\n")
    .trim()
  return text || undefined
}

/** The mission for `root` at `since` (when the mode came on): the 3 nearest person messages up to then, and all after. */
export function window(messages: readonly SessionV1.WithParts[], input: { root: string; since: number }) {
  const entries = messages
    // A subagent's prompt is a user message in its own child session, never in the root.
    .filter((message) => message.info.sessionID === input.root)
    .flatMap((message): Entry[] => {
      const text = personText(message)
      return text ? [{ messageID: message.info.id, created: message.info.time.created, text }] : []
    })
    .toSorted((a, b) => a.created - b.created)
  const before = entries.filter((entry) => entry.created <= input.since).slice(-MISSION_WINDOW)
  const after = entries.filter((entry) => entry.created > input.since)
  return [...before, ...after]
}

/** The sentences of the mission that ask the agent to ask first. None means fully autonomous (U13). */
export function asks(entries: readonly Entry[]) {
  return entries.flatMap((entry) => sentences(entry.text)).filter((sentence) => ASK_PATTERNS.some((p) => p.test(sentence)))
}

/** Whether `quote` is an exact piece, spaces aside, of a sentence in the mission that asks to be asked. */
export function quoted(quote: string, entries: readonly Entry[]) {
  const needle = normalize(quote)
  if (needle.length < QUOTE_MIN_CHARS) return false
  return asks(entries).some((sentence) => normalize(sentence).includes(needle))
}

function typed(part: SessionV1.TextPart) {
  if (part.synthetic || part.ignored || part.metadata?.lateAnswer) return
  const command = part.metadata?.command
  if (command === undefined) return part.text
  const args = part.metadata?.arguments
  return typeof args === "string" ? args : undefined
}

function sentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const ASK_PATTERNS = ASK_LEXICON.map(
  (term) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu"),
)

export * as MissionWindow from "./mission-window"
