// Lane-control reader, validator and setup writer (blueprint 11 row 245).
//
// WHAT THIS IS: the storage side of the lane feature specified by
// masterplan/06_s6b_lanes_spec.md — one file, `~/.swarm/setup/lanes.json` (PC-PATH-18, mode 0600
// inside the 0700 PC-PATH-01 dir), holding the three knobs this pinned build actually reads. The
// renderer (composefiles/index.ts) reads it through here and REFUSES the render on any invalid
// content rather than defaulting (§4.1's second boundary decision: falling back on a hand-edited
// file would produce an estate that contradicts the file the user just edited).
//
// THE THREE CONTROLS (§3.1), and the one amendment that changed two of their numbers:
// gate 239 fork H (`decisions/decisions.md`, entry "gate 239 answered", bullet H) rules that
// `NUQ_WORKER_COUNT` SHIPS AT 5, not 4 — row 237 §6.2's "write the floor everywhere" ruling is
// overridden for this control because writing 4 costs a worker and drops below the compiled
// per-team job ceiling of 5 (`api:/app/dist/src/lib/concurrency-limit.js:39`, read by row 236 §3.3).
// The floor of 4 survives as a VALIDATION BOUNDARY (refuse below 4), never as a setup-time write.
// The value is still recorded explicitly rather than left unset: 237 §6.2's reason stands — a dial
// whose absence means "whatever the vendor chose" is the exact ambiguity this feature exists to
// remove. Ranges below are row 238's PUBLISHED ceilings (`research/s6b_07_capacity_envelope.md`
// §9.3 item 1: shipped ranges [4,5], [4,4], [4,4]), which sit inside row 237 §3.1's spec caps
// [4,8], [4,8], [4,6]; 237 §8.2 splits the two roles deliberately — 237 owns the cap, 238 owns the
// number the validator refuses against, and only downward. Where the two tables differ they are not
// reconciled here: 238's numbers ship and the difference is reported.
//
// REFUSAL, NOT COERCION (§4): no clamping, no rounding, no closest-allowed-value, no
// default-on-error. Three tokens, shared verbatim with the route (row 247) and the units (row 250):
//   LANE_VALUE_OUT_OF_RANGE — an integer outside that control's [min,max], BELOW the floor included
//                             (1 is exactly what the user told us not to ship, decisions.md:214-217)
//   LANE_VALUE_NOT_A_LANE   — a key outside the closed three-name set, so NUM_WORKERS_PER_QUEUE,
//                             MAX_CONCURRENT_JOBS, pool_maxsize, laneCount or any other relabelling
//                             cannot re-enter through the storage layer (§2.4's closed key set)
//   LANE_VALUE_MALFORMED    — anything that is not a JSON integer: string, float, boolean, null,
//                             array, object, negative zero, or a file that is not JSON at all
// Each refusal carries the offending key and writes nothing (§4.2: validation completes before the
// first filesystem call, so no temp file and no directory entry can exist behind it).
//
// NO COLLAPSE, NO FREE-FORM VALUES (§4.3): there is no `laneCount`, no scalar `lanes`, no derived
// aggregate anywhere in this schema, and every consumer renders its OWN literal from its OWN key —
// one number never drives several keys. Values are integers inside published ranges; there is no
// raw-env field and no passthrough map into container environment, which is what keeps a
// user-editable file from becoming an injection surface into compose (§4.3, row 251's subject).

import { chmodSync, existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { atomicWriteJson } from "../atomic.ts"
import { MODES } from "../constants.ts"
import { ensureDir } from "../paths.ts"

/** PC-PATH-18 (proposed at 06_s6b_lanes_spec.md §2.1, id fixed by the controller for this row):
 *  `~/.swarm/setup/lanes.json`, 0600 in the 0700 setup dir. Resolved from the render context's home
 *  anchor exactly as dns_pins.ts resolves PC-PATH-19 — the same single-resolver rule (§5.1 item 6):
 *  the reader reads where the writer writes, keyed off ctx.home so tests pin it. The constant lives
 *  HERE, not in constants.ts, because constants.ts is row-81 owned (same reason PC_PORTS lives in
 *  shared.ts:282-291 and PC-PATH-19 lives in dns_pins.ts:39-45); registration stays routed to row 72. */
export function lanesPath(home: string): string {
  return join(home, ".swarm", "setup", "lanes.json")
}

export type LaneKey = "NUQ_WORKER_COUNT" | "MAX_CONCURRENT_PAGES" | "GRANIAN_BLOCKING_THREADS"

export type LaneRefusalToken = "LANE_VALUE_OUT_OF_RANGE" | "LANE_VALUE_NOT_A_LANE" | "LANE_VALUE_MALFORMED"

export interface LaneControl {
  readonly key: LaneKey
  /** Validator bounds. min is the user's floor (decisions.md:214-217); max is row 238's published
   *  shipped ceiling, which sits inside row 237 §3.1's spec cap and may only ever move down. */
  readonly min: number
  readonly max: number
  /** What the setup-time create-if-absent write stores. Fork H: 5 for C-1 (the floor is a boundary,
   *  not a write), 4 for C-2 (the one genuine raise, 2 -> 4), 4 for C-3 (a no-op that transfers
   *  ownership of the image-baked 4 — 06 §5.1's caveat, stated rather than hidden). */
  readonly setupValue: number
  readonly stack: "firecrawl" | "searxng"
  readonly service: "api" | "playwright-service" | "searxng"
  /** Provenance of the bound, carried so a card (row 248) can cite it instead of restating it. */
  readonly basis: string
}

/** The whole vocabulary of this control family, in render order. Three entries, and the closed-set
 *  check below makes that list exhaustive by construction rather than by convention. */
export const LANE_CONTROLS: readonly LaneControl[] = [
  {
    key: "NUQ_WORKER_COUNT",
    min: 4,
    max: 5,
    setupValue: 5,
    stack: "firecrawl",
    service: "api",
    // floor: decisions.md:214-217 · ceiling: s6b_07 §4.1 ("Published shipped ceiling: 5") ·
    // live key: api:/app/dist/src/config.js:341, consumed harness.js:109/:110/:660 (row 236 §3.3)
    basis: "row 238 §4.1 published ceiling 5 inside row 237 §3.1 cap 8; fork H ships the stored value at 5",
  },
  {
    key: "MAX_CONCURRENT_PAGES",
    min: 4,
    max: 4,
    setupValue: 4,
    stack: "firecrawl",
    service: "playwright-service",
    // floor: decisions.md:214-217 · ceiling: s6b_07 §4.2 ("Published shipped ceiling: 4", single
    // position until row 256 produces per-page RSS/shm figures) · live key: pw:/usr/src/app/api.ts:26-29,
    // Semaphore at :160 (row 236 §3.5); our render cut it from the vendor's 10 to 2
    basis: "row 238 §4.2 publishes [4,4] inside row 237 §3.1 cap 8; the only crawl number that moves up",
  },
  {
    key: "GRANIAN_BLOCKING_THREADS",
    min: 4,
    max: 4,
    setupValue: 4,
    stack: "searxng",
    service: "searxng",
    // floor: decisions.md:214-217 · ceiling: s6b_07 §4.3 ("Published shipped ceiling: 4") against
    // mem_limit 512m (searxng_compose.ts:81-82) · live key: baked image ENV, honoured through
    // auto_envvar_prefix='GRANIAN' (granian/cli.py:606, row 236 §4.2)
    basis: "row 238 §4.3 publishes [4,4] inside row 237 §3.1 cap 6; writing it takes ownership of the baked 4",
  },
] as const

const CONTROL_BY_KEY: ReadonlyMap<string, LaneControl> = new Map(LANE_CONTROLS.map((c) => [c.key, c]))

/** The tuple the setup writes when no file exists (06 §2.3 create-if-absent + gate 239 fork H). */
export const SETUP_LANE_VALUES: Readonly<Record<LaneKey, number>> = {
  NUQ_WORKER_COUNT: 5,
  MAX_CONCURRENT_PAGES: 4,
  GRANIAN_BLOCKING_THREADS: 4,
}

/** Validated lane values, sparse by design: an absent key means "unset", and an unset control
 *  renders exactly as it does today (06 §5.1 rule 4). Absence is never filled with a default here —
 *  that would be the coercion this spec bans. */
export type LaneValues = Readonly<Partial<Record<LaneKey, number>>>

export interface LanesDocument {
  readonly lanes: LaneValues
  /** Present only when the file carried it. The reader must NOT infer an age from its absence
   *  (06 §2.4's caution, learned from state.ts:94's normalise() fabricating one). */
  readonly updatedAt?: string
}

export type LanesRead =
  | ({ readonly ok: true; readonly present: boolean } & LanesDocument)
  | { readonly ok: false; readonly token: LaneRefusalToken; readonly key?: string; readonly message: string }

type Refusal = { readonly ok: false; readonly token: LaneRefusalToken; readonly key?: string; readonly message: string }

const malformed = (message: string, key?: string): Refusal => ({ ok: false, token: "LANE_VALUE_MALFORMED", key, message })
const notALane = (key: string): Refusal => ({
  ok: false,
  token: "LANE_VALUE_NOT_A_LANE",
  key,
  // No echo of the value (§4.1's wire shape for this token): a hostile file could otherwise carry an
  // arbitrary payload under a bad name and have it reflected back through the refusal.
  message: `"${key}" is not a lane control — the accepted vocabulary is exactly ${LANE_CONTROLS.map((c) => c.key).join(", ")} (06 §2.4 closed key set; §4.1 refuses relabellings rather than ignoring them)`,
})

/** Read + validate the lane file. An ABSENT file is legal and yields no configured controls — the
 *  byte-identical default render (AC-237-1). Anything else that does not fully validate refuses. */
export function readLanes(home: string): LanesRead {
  const path = lanesPath(home)
  if (!existsSync(path)) return { ok: true, present: false, lanes: {} }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return malformed(`${path}: unreadable (${(err as Error).message}) — refusing rather than guessing around a file that exists`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return malformed(`${path}: malformed JSON (${(err as Error).message}) — §4.1 refuses a bad file instead of falling back to defaults`)
  }
  const validated = validateLanesDocument(doc)
  if (!validated.ok) return { ...validated, message: `${path}: ${validated.message}` }
  return { ok: true, present: true, ...validated.document }
}

/** The schema gate, exported for the desktop route (row 247) so the file's two writers and the
 *  render share ONE validator — the same no-second-deny-list reasoning that made dns_pins.ts reuse
 *  urlpolicy's predicates instead of re-listing classes. Pass order is fixed and documented below so
 *  a file with several defects always refuses with the same token. */
export function validateLanesDocument(
  doc: unknown,
): { ok: true; document: LanesDocument } | Refusal {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return malformed(`top level must be an object of the shape { version, updatedAt?, lanes } (06 §2.4)`)
  const record = doc as Record<string, unknown>

  if (record.version !== 1)
    return malformed(`version must be exactly 1 (schema version, mirroring STATE_SCHEMA_VERSION at constants.ts:118), got ${JSON.stringify(record.version)}`)

  // Structure before content: an unknown top-level field is schema drift, and a reader that ignored
  // it would be guessing which of two shapes wrote the file. Labelled a decision inside the spec's
  // silence — 06 §2.4 closes the LANES key set but names no rule for the envelope.
  for (const name of Object.keys(record)) {
    if (name === "version" || name === "updatedAt" || name === "lanes") continue
    return malformed(`unknown top-level field "${name}" — the documented shape is version, updatedAt and lanes only (06 §2.4)`)
  }

  if (record.updatedAt !== undefined && (typeof record.updatedAt !== "string" || record.updatedAt.length === 0))
    return malformed("updatedAt must be a non-empty string when present, and its absence means \"never set from the app\" — the reader must not fabricate an age (06 §2.4)", "updatedAt")

  const lanesField = record.lanes
  if (typeof lanesField !== "object" || lanesField === null || Array.isArray(lanesField))
    return malformed(`lanes must be an object of control-name to integer (06 §2.4)`)
  const lanesRecord = lanesField as Record<string, unknown>

  // Pass 1 — names. Every key must be one of the three, checked before any value is looked at, so a
  // file that both renames a knob and gives it a bad value reports the rename (the more dangerous of
  // the two: an inert key that looks live is the K1-K4 defect this addendum exists to retire).
  for (const name of Object.keys(lanesRecord)) {
    if (CONTROL_BY_KEY.has(name)) continue
    return notALane(name)
  }

  // Pass 2 — shapes. Integers only: no strings, no floats, no booleans, no nulls, no arrays, no
  // nested objects (AC-237-5). JSON.parse happily accepts all of those, which is why this gate is not
  // optional. -0 is refused by name: it is an integer to Number.isInteger and a surprise everywhere
  // else, and §4.1 lists "negative-zero oddities" under this token.
  for (const control of LANE_CONTROLS) {
    const value = lanesRecord[control.key]
    if (value === undefined) continue // unset control: renders as today (06 §5.1 rule 4)
    if (typeof value !== "number" || !Number.isInteger(value) || Object.is(value, -0))
      return malformed(`${control.key}: expected an integer, got ${describeShape(value)} (06 §4.1 malformed branch)`, control.key)
  }

  // Pass 3 — ranges, including the below-floor leg: 1 is the value the user forbade, and a clamp
  // would turn that mistake into a silent configuration change (§4).
  for (const control of LANE_CONTROLS) {
    const value = lanesRecord[control.key]
    if (typeof value !== "number") continue
    if (value < control.min || value > control.max)
      return {
        ok: false,
        token: "LANE_VALUE_OUT_OF_RANGE",
        key: control.key,
        message: `${control.key}: ${value} is outside [${control.min},${control.max}] — ${control.basis}. Refused, not clamped (06 §4)`,
      }
  }

  const out: { [K in LaneKey]?: number } = {}
  for (const control of LANE_CONTROLS) {
    const value = lanesRecord[control.key]
    if (typeof value === "number") out[control.key] = value
  }
  return {
    ok: true,
    document: {
      lanes: out,
      ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    },
  }
}

function describeShape(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "number") return `the non-integer number ${JSON.stringify(value)}`
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`
  return `a ${typeof value}`
}

// --- setup-time writer (06 §2.3: swarm-setup may create-if-absent, never overwrite) -------------

export interface LanesWriteReport {
  readonly path: string
  readonly created: boolean
  readonly dirModeBefore: number
  /** True when the directory was found at a mode other than 0700 and was repaired. The repair is
   *  inside the permitted boundary (paths.ts:39-41 records that P-4 bars chmod OUTSIDE ~/.swarm, and
   *  this dir is PC-PATH-01 inside it); refusing outright was rejected at 06 §8.3 because it would
   *  make the control unusable over a cosmetic drift on a machine the user owns. */
  readonly dirModeRepaired: boolean
  readonly dirModeAfter: number
  readonly fileMode: number
}

/** Create `~/.swarm/setup/lanes.json` with the fork-H tuple when absent; leave an existing file
 *  untouched either way.
 *
 *  WHY THE DIRECTORY MODE IS VERIFIED AND NOT ASSUMED: ensureDir applies its mode only when it
 *  CREATES (paths.ts:42-46 — "if it already exists we do not chmod it"), so a setup dir found at
 *  0755 after some other program's umask would otherwise receive a private-looking 0600 file inside
 *  a world-traversable directory, silently. The write therefore stats the directory first, repairs a
 *  wrong mode, and reports what it found (AC-237-6). */
export function createLanesFileAtSetup(home: string): LanesWriteReport {
  const path = lanesPath(home)
  const dir = join(home, ".swarm", "setup")
  ensureDir(dir, MODES.DIR_0700)
  const dirModeBefore = statSync(dir).mode & 0o777
  const dirModeRepaired = dirModeBefore !== MODES.DIR_0700
  if (dirModeRepaired) chmodSync(dir, MODES.DIR_0700)
  const existed = existsSync(path)
  if (!existed)
    atomicWriteJson(path, { version: 1, lanes: SETUP_LANE_VALUES }, MODES.FILE_0600)
  return {
    path,
    created: !existed,
    dirModeBefore,
    dirModeRepaired,
    dirModeAfter: statSync(dir).mode & 0o777,
    fileMode: statSync(path).mode & 0o777,
  }
}
