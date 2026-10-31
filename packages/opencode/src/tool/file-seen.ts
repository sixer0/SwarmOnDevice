// What each agent last saw of each file, so that a full-file write cannot erase work it never knew about: another
// subagent's, or the person's in their editor. This is per process on purpose. What it protects against is in-flight.
import { applyPatch, createTwoFilesPatch, structuredPatch } from "diff"

const MAX_FILE = 1024 * 1024
const MAX_TOTAL = 64 * 1024 * 1024

const seen = new Map<string, string>()
const writers = new Map<string, string>()
let total = 0

const key = (session: string, file: string) => `${session}\0${file}`

function forget(id: string) {
  const text = seen.get(id)
  if (text === undefined) return
  total -= text.length
  seen.delete(id)
}

export function record(session: string, file: string, text: string) {
  const id = key(session, file)
  forget(id)
  if (text.length > MAX_FILE) return
  seen.set(id, text)
  total += text.length
  // Map keeps insertion order, and record re-inserts: the first key is the one untouched for longest.
  for (const oldest of seen.keys()) {
    if (total <= MAX_TOTAL) break
    forget(oldest)
  }
}

export const lastSeen = (session: string, file: string) => seen.get(key(session, file))

export function wrote(session: string, file: string, text: string) {
  record(session, file, text)
  writers.set(file, session)
}

/** Applies the change from `base` to `ours` on top of `theirs`. undefined means the two overlap. */
export function merge(base: string, ours: string, theirs: string) {
  const merged = applyPatch(theirs, structuredPatch("file", "file", base, ours, "", "", { context: 2 }))
  return merged === false ? undefined : merged
}

export type Decision = { text: string; merged: boolean } | { refused: string }

/** What a full-file write should put on disk, given what is there now. */
export function decide(input: { session: string; file: string; label: string; current: string | undefined; next: string }): Decision {
  const { session, file, label, current, next } = input
  if (current === undefined || current === next) return { text: next, merged: false }
  const base = lastSeen(session, file)
  if (base === undefined) {
    const writer = writers.get(file)
    if (!writer || writer === session) return { text: next, merged: false }
    return {
      refused: `Not written: another agent wrote ${label} while you were working, and you have not read it, so this would erase its work. Nothing changed. Read the file, then make your change on top of what is there.`,
    }
  }
  if (base === current) return { text: next, merged: false }
  const merged = merge(base, next, current)
  if (merged !== undefined) return { text: merged, merged: true }
  return {
    refused: [
      `Not written: ${label} changed after you last read it, and those changes overlap yours. Nothing was lost. Read the file again and redo your change on top of it. What changed:`,
      createTwoFilesPatch(label, label, base, current, "", "", { context: 1 }).split("\n").slice(2, 60).join("\n"),
    ].join("\n"),
  }
}

export const MERGED_NOTE =
  "Someone else changed this file after you last read it. Their changes were kept and yours applied on top. Read it again before changing it further."

/** Why an edit's oldString may be missing: it is often not a bad match, the file moved on underneath. */
export function changedNote(session: string, file: string, current: string) {
  const base = lastSeen(session, file)
  if (base === undefined || base === current) return ""
  return " This file changed after you last read it, by another agent or a person. Read it again before retrying."
}

export * as FileSeen from "./file-seen"
