/**
 * 1.3.3 row 99 (spec KL-2 item 1, register "Match rule"): the trigger matcher the mission tools call at
 * `studio_mission_create` and when a row becomes `running` (row 101 wires it). It reads `indeks_pemicu.json`, the
 * index written by `build_kl_index.py` (decision C27: packages/desktop/datum/knowledge-library/scripts/), and must
 * give the same domains as that script's `match()`; test/kl2-trigger-matcher/row99-python-parity.test.ts runs both.
 *
 * Mirrored exactly from `build_kl_index.match` (do not "improve" one side only):
 * - text: `text.lower()`, then every run of characters outside `0-9 a-z à-ÿ / + -` becomes one space, padded with
 *   one space each side. No Unicode normalisation (NFC/NFKC): the Python side does none, so neither does this one.
 * - terms: only `terms` of each domain (not `terms_from_cards`), terms of one character are skipped; a term (also a
 *   two-word phrase such as `satu garis`) hits when ` term ` occurs in the padded text, i.e. whole words only.
 * - rule: a domain is selected by one strong word or by two found words; weak = the index's `weak` key (decision C7
 *   item 2; the builder writes `sorted(WEAK)`), so both sides read one list.
 * - order: by number of found words, descending; ties keep the index's domain order. Found words sorted.
 *
 * Never throws: a missing, unreadable or malformed index gives no domains and a reason, so the mission tool works.
 */
import fs from "node:fs"
import path from "node:path"

export const TRIGGER_INDEX_FILE = "indeks_pemicu.json"

/** Prefix of a first file that lives in the built-in skills folder, not in the library (row 95, DIAGRAM-STANDARD). */
export const SKILL_FILE_PREFIX = "skill:"

export type TriggerIndex = {
  domains: Array<{ domain: string; terms: string[]; firstFile: string | undefined }>
  weak: Set<string>
}

export type KnowledgeHit = { domain: string; firstFile: string; words: string[] }

export type KnowledgeMatch = { domains: KnowledgeHit[]; reason?: string }

/**
 * Match a mission or row text (row 101 joins title and description with one space) against the index file.
 * `indexPath` comes from `resolveTriggerIndexPath`; undefined means the host has no library.
 */
export function matchKnowledgeFromFile(text: string, indexPath: string | undefined): KnowledgeMatch {
  if (!indexPath) return { domains: [], reason: "index path not known" }
  const loaded = loadTriggerIndex(indexPath)
  if (!loaded.index) return { domains: [], reason: loaded.reason }
  return { domains: matchKnowledge(text, loaded.index) }
}

export function matchKnowledge(text: string, index: TriggerIndex): KnowledgeHit[] {
  const low = normaliseForMatch(text)
  return index.domains
    .flatMap((d) => {
      const words = [...new Set(d.terms.filter((w) => [...w].length > 1 && low.includes(" " + w + " ")))].sort(byCodePoint)
      if (!d.firstFile) return []
      if (!words.some((w) => !index.weak.has(w)) && words.length < 2) return []
      return [{ domain: d.domain, firstFile: d.firstFile, words }]
    })
    .sort((a, b) => b.words.length - a.words.length)
}

/** `" " + re.sub(r"[^0-9a-zà-ÿ/+\-]+", " ", text.lower()) + " "` from build_kl_index.match. */
export function normaliseForMatch(text: string) {
  return " " + text.toLowerCase().replace(/[^0-9a-zà-ÿ/+\-]+/gu, " ") + " "
}

/**
 * 1.3.3 row 151 (senior review S8): THE one loader of the trigger index. The matcher (create/start, rows 99/101) and
 * `studio_library_read` (row 100, domain of a read) both call it, so they always load the same file.
 *
 * Search list (the union both readers needed; first hit wins, nothing else is opened):
 *   1. `explicitPath` (tests and dev only; the host passes none),
 *   2. per folder, in order: the library root, `knowledge-library-index/` (register line 48, name of a staged copy),
 *      LIBRARY_INDEX_BASE (the edition's indexed text layer, where an edition may carry its own index);
 *      in each folder the builder name `indeks_pemicu.json` (row 96 stages it at the root), then the edition name
 *      `INDEKS-PEMICU.json` (spec KL-1).
 * A candidate counts only when it is a regular file, not a symbolic link, of at most TRIGGER_INDEX_MAX_BYTES. The first
 * such file is THE index: when it does not parse, neither side falls through to a later candidate (both see no index).
 * The parsed document is cached per file, size and mtime.
 */
export function loadTriggerIndex(indexPath: string): { index?: TriggerIndex; reason: string } {
  const doc = readTriggerIndexDoc(indexPath)
  if (!doc.value) return { reason: doc.reason }
  const value = doc.value
  if (!Array.isArray(value.weak)) return { reason: "index has no weak list" }
  return {
    reason: "",
    index: {
      weak: new Set(value.weak.filter((w): w is string => typeof w === "string")),
      domains: Object.entries(value.domains as Record<string, unknown>).map(([domain, entry]) => ({
        domain,
        terms: isRecord(entry) && Array.isArray(entry.terms) ? entry.terms.filter((w): w is string => typeof w === "string") : [],
        firstFile:
          isRecord(entry) && Array.isArray(entry.read_order) && typeof entry.read_order[0] === "string"
            ? entry.read_order[0]
            : undefined,
      })),
    },
  }
}

/** The edition name of the trigger index (spec KL-1); the builder's name is TRIGGER_INDEX_FILE. */
export const TRIGGER_INDEX_EDITION_FILE = "INDEKS-PEMICU.json"
/** File names looked for in each folder, in order. */
export const TRIGGER_INDEX_NAMES: readonly string[] = [TRIGGER_INDEX_FILE, TRIGGER_INDEX_EDITION_FILE]
/** The indexed text layer inside the library folder (`root_relative` of the index builder; paths of `read_order`). */
export const LIBRARY_INDEX_BASE = "4 Knowledge Bank/ekas-lapis-teks"
/** Folders under the library root looked in, in order ("" = the root itself). */
export const TRIGGER_INDEX_FOLDERS: readonly string[] = ["", "knowledge-library-index", LIBRARY_INDEX_BASE]
/** A larger index file is skipped (the real one is about 60 KB). */
export const TRIGGER_INDEX_MAX_BYTES = 2_097_152

/** The search list above, in order. */
export function triggerIndexCandidates(input: { libraryRoot?: string | null; explicitPath?: string }) {
  const root = input.libraryRoot
  return [
    ...(input.explicitPath ? [input.explicitPath] : []),
    ...(root ? TRIGGER_INDEX_FOLDERS.flatMap((folder) => TRIGGER_INDEX_NAMES.map((name) => path.join(root, ...folder.split("/").filter(Boolean), name))) : []),
  ]
}

/** The first usable candidate (regular file, not a link, within the cap), or undefined. Never throws. */
export function resolveTriggerIndexPath(input: { libraryRoot?: string | null; explicitPath?: string }) {
  return triggerIndexCandidates(input).find((file) => {
    try {
      const st = fs.lstatSync(file, { throwIfNoEntry: false })
      return !!st && st.isFile() && !st.isSymbolicLink() && st.size <= TRIGGER_INDEX_MAX_BYTES
    } catch {
      return false
    }
  })
}

/**
 * The real library root: an absolute path whose real path is a folder, else null. Never throws. The ONE resolution:
 * start.ts applies it to STUDIO_LIBRARY_ROOT once and passes the result down; `studio_library_read` and the matcher
 * apply it again to what they were given (a no-op on a real folder), so both stand on the same folder.
 */
export function libraryRootOf(root: string | null | undefined): string | null {
  if (typeof root !== "string" || !path.isAbsolute(root)) return null
  try {
    const real = fs.realpathSync(root)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

type DocResult = { value?: Record<string, unknown>; reason: string }
const docCache = new Map<string, { key: string; doc: DocResult }>()

/**
 * The parsed index document at `file` (an object with a `domains` object), or the reason there is none. Cached per
 * file, size and mtime (a rewrite with a new mtime is read again). Never throws.
 */
export function readTriggerIndexDoc(file: string): DocResult {
  let key: string
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return { reason: "index not readable: not a file" }
    if (st.size > TRIGGER_INDEX_MAX_BYTES) return { reason: `index not readable: ${st.size} B, over the ${TRIGGER_INDEX_MAX_BYTES} B cap` }
    key = `${st.size}:${st.mtimeMs}`
  } catch (error) {
    return { reason: "index not readable: " + (error instanceof Error ? error.message : String(error)) }
  }
  const hit = docCache.get(file)
  if (hit && hit.key === key) return hit.doc
  const doc = parseDoc(file)
  docCache.set(file, { key, doc })
  return doc
}

function parseDoc(file: string): DocResult {
  const raw = readText(file)
  if (raw.error) return { reason: "index not readable: " + raw.error }
  const json = parseJson(raw.text)
  if (json.error) return { reason: "index not JSON: " + json.error }
  const value = json.value
  if (!isRecord(value) || !isRecord(value.domains)) return { reason: "index has no domains" }
  return { value, reason: "" }
}

/** A first file is relative to the library root, or with `skill:` relative to the built-in skills folder. */
export function firstFileLocation(firstFile: string) {
  if (firstFile.startsWith(SKILL_FILE_PREFIX)) return { base: "skill" as const, path: firstFile.slice(SKILL_FILE_PREFIX.length) }
  return { base: "library" as const, path: firstFile }
}

// Python `sorted()` on str compares code points; plain `<` on JS strings compares UTF-16 units. Terms are Latin-1.
function byCodePoint(a: string, b: string) {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function readText(file: string) {
  try {
    return { text: fs.readFileSync(file, "utf8") }
  } catch (error) {
    return { text: "", error: error instanceof Error ? error.message : String(error) }
  }
}

function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
