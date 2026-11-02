// What autonomous mode asks once, when the mission is known: the secret and sensitive files in the project, the secret
// paths outside it that the person's message names, and the destinations this work may send to. Only names are looked
// at. No file is opened, so a scan cannot put a credential in front of the model or in the audit. A consent covers the
// concrete paths listed here and nothing that turns up later: a file that is not in the list stays held.
import { createHash } from "node:crypto"
import { opendir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { Reach } from "../tool/reach"
import { Risk } from "../tool/risk"

export const CONSENT_SCAN_MAX_FILES = 2000
export const CONSENT_SCAN_MAX_MS = 2000
export const CONSENT_LIST_MAX = 50

export type ItemKind = "secret" | "sensitive" | "outside" | "destination"

/** A destination as the known-destinations module (row 107) describes it, already matched against the mission text. */
export interface Destination {
  id: string
  label: string
  named: boolean
  /** Reaches any host, such as web fetch. It is shown with its label and is never ticked for the person. */
  broad?: boolean
}

export interface Item {
  id: string
  kind: ItemKind
  /** What the person reads: `.env*`, `*.pem`, `.github/**`, a path outside, or a destination label. */
  pattern: string
  /** Concrete absolute paths the consent covers. Empty for a destination. */
  files: string[]
  named: boolean
  checked: boolean
}

export interface Input {
  instance: InstanceContext
  /** The person's own typed text in the mission window (row 102). Nothing a tool, a file or a template wrote. */
  mission: string[]
  destinations?: Destination[]
  maxFiles?: number
  maxMs?: number
  now?: () => number
}

export interface Result {
  items: Item[]
  /** Entries looked at inside the project. */
  scanned: number
  /** Why the walk stopped early, if it did. Whatever it did not reach stays held. */
  stopped?: "files" | "time"
  /** Items left off the list by CONSENT_LIST_MAX. They stay held. */
  dropped: number
  /** For the `consent_shown` marker: the same list gives the same hash. */
  hash: string
}

// Contents are never wanted, and these hold far more names than any person could review.
const SKIP_DIRECTORIES = new Set(["node_modules", ".git"])
const KIND_ORDER: Record<ItemKind, number> = { secret: 0, outside: 1, destination: 2, sensitive: 3 }
const WHOLE_EXTENSION = /\.(pem|key|p12|pfx|keystore|jks|tfstate)$/i
const TRIM = /^[\s"'`([{<]+|[\s"'`)\]}>,;:!?]+$|\.+$/g

/** Words of the person's text that could name a path: quotes and closing punctuation taken off. */
function tokens(mission: string[]) {
  return new Set(
    mission
      .flatMap((text) => text.split(/\s+/))
      .map((word) => word.replace(TRIM, "").replace(/^\.\//, ""))
      .filter((word) => word.length > 0),
  )
}

/** A file is named when the text gives its path, its name, or a folder it sits in. */
function namedIn(words: Set<string>, relative: string) {
  const parts = relative.split("/")
  if (words.has(parts.at(-1)!)) return true
  return parts.some((_, index) => words.has(parts.slice(0, index + 1).join("/")))
}

function secretPattern(relative: string) {
  const parts = relative.split("/")
  const base = parts.at(-1)!.toLowerCase()
  if (base.startsWith(".env")) return ".env*"
  const extension = base.match(WHOLE_EXTENSION)
  if (extension) return `*${extension[0]}`
  const holder = parts.slice(0, -1).findIndex((part) => /^(\.envs|\.?secrets?)$/i.test(part))
  if (holder >= 0) return `${parts.slice(0, holder + 1).join("/")}/**`
  return parts.at(-1)!
}

function sensitivePattern(relative: string) {
  const parts = relative.split("/")
  if (parts.length > 1 && Risk.sensitive(parts[0])) return `${parts[0]}/**`
  return parts.at(-1)!
}

/** Paths outside the project that the person's text names and that a read could not show the model without asking. */
function outside(words: Set<string>, instance: InstanceContext) {
  const home = homedir()
  return [...words].flatMap((word) => {
    if (!word.startsWith("/") && !word.startsWith("~/")) return []
    const file = path.resolve(word.startsWith("~/") ? path.join(home, word.slice(2)) : word)
    if (containsPath(file, instance) || Reach.readable(file)) return []
    return [{ word, file }]
  })
}

export async function scan(input: Input): Promise<Result> {
  const { instance } = input
  const maxFiles = input.maxFiles ?? CONSENT_SCAN_MAX_FILES
  const maxMs = input.maxMs ?? CONSENT_SCAN_MAX_MS
  const now = input.now ?? (() => performance.now())
  const deadline = now() + maxMs
  const words = tokens(input.mission)
  const groups = new Map<string, Item>()
  const add = (kind: ItemKind, pattern: string, file: string | undefined, named: boolean) => {
    const id = `${kind}:${pattern}`
    const item = groups.get(id) ?? { id, kind, pattern, files: [], named: false, checked: false }
    if (file) item.files.push(file)
    item.named ||= named
    item.checked = item.named
    groups.set(id, item)
  }

  const root = instance.directory
  let scanned = 0
  let stopped: Result["stopped"]
  const queue = [root]
  walk: while (queue.length > 0) {
    const directory = queue.shift()!
    const entries = await opendir(directory).catch(() => undefined)
    if (!entries) continue
    for await (const entry of entries) {
      if (scanned >= maxFiles) {
        stopped = "files"
        break walk
      }
      if (now() > deadline) {
        stopped = "time"
        break walk
      }
      scanned++
      const file = path.join(directory, entry.name)
      // A linked folder is checked by its name like a file and not walked: it can lead out of the project or round in a loop.
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(file)
        continue
      }
      const relative = path.relative(root, file).replaceAll(path.sep, "/")
      const named = namedIn(words, relative)
      if (Reach.secret(file)) add("secret", secretPattern(relative), file, named)
      else if (Reach.sensitive(file, instance)) add("sensitive", sensitivePattern(relative), file, named)
    }
  }

  for (const { word, file } of outside(words, instance)) add("outside", word, file, true)
  for (const destination of input.destinations ?? []) {
    const id = `destination:${destination.id}`
    groups.set(id, {
      id,
      kind: "destination",
      pattern: destination.label,
      files: [],
      named: destination.named,
      checked: destination.named && !destination.broad,
    })
  }

  const ordered = [...groups.values()]
    .map((item) => ({ ...item, files: [...item.files].sort() }))
    .sort(
      (a, b) =>
        Number(b.named) - Number(a.named) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.pattern.localeCompare(b.pattern),
    )
  const items = ordered.slice(0, CONSENT_LIST_MAX)
  const hash = createHash("sha256")
    .update(JSON.stringify(items.map((item) => [item.id, item.files, item.checked])))
    .digest("hex")
  return { items, scanned, stopped, dropped: ordered.length - items.length, hash }
}

export * as ConsentScan from "./consent-scan"
