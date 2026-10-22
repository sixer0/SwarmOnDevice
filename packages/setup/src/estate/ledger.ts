// Estate delivery ledger — PC-PATH-20 (row 263, masterplan/08_s6b_estate_delivery_spec.md §5.2).
//
// One JSONL row per delivery ATTEMPT SEQUENCE at ~/.swarm/setup/estate-delivery.jsonl, beside
// provenance.jsonl (row 81) and stack-provenance.jsonl (row 91) in the setup root, taking their
// mode classes (dir 0700 / file 0600, the register rule quoted at provenance.ts:6) and their
// durability rule ("Each append is followed by an fsync (FIX4 / F-R109-2)", provenance.ts:10-11).
//
// WHY A SEPARATE LEDGER (D-262-3, ratified decisions/decisions.md:432-435): StackProvenanceRecord's
// action set is closed under the R112b-7 truthfulness ruling (stacklib.ts:814-819) and every other
// field is docker-shaped; recording a file write there would mean inventing containers/healthDetail/
// exitCode values against that ledger's own "never a fabricated 0" standard (stacklib.ts:831-833).
//
// UNMISSABILITY (spec §5.3): D-A hash-before-hindsight — every artefact row carries the sha256 the
// writer intended, recorded at the moment it wrote. D-B program.compiled — read from
// isCompiledBinary(), never from argv; the harness recipe (repo source + local bun + R93_LIVE=1)
// can never set it true, so a compiled:true row can only come from the product. D-C intent-precedes-
// bytes — the attempt row is appended before a single artefact byte moves.
//
// NEVER contains secret values (P-8 — same boundary as provenance.ts:14 and stacklib.ts:844): the
// secrets array records slot names, actions and modes only.
//
// Register-id note: the spec drafted PC-PATH-18 for this file; the controller's numbering ruling
// (decisions/decisions.md:439-444) settled PC-PATH-18 = lanes.json, PC-PATH-19 = dns-pins.json and
// THIS ledger at PC-PATH-20. The id is pending the register amendment (spec GAP-3, routed to row 72's
// seat); until it lands this comment is the registration claim.

import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs"
import { MODES, PROGRAM_NAME } from "../constants.ts"
import { ensureParent, isCompiledBinary, setupRoot } from "../paths.ts"

export const ESTATE_DELIVERY_FILE_NAME = "estate-delivery.jsonl"

/** Resolved lazily (paths.ts resolves $HOME per call) so a test pins HOME at a throwaway dir. */
export function estateDeliveryFile(): string {
  return `${setupRoot()}/${ESTATE_DELIVERY_FILE_NAME}` // PC-PATH-20
}

export interface EstateArtefactRow {
  readonly relPath: string
  readonly absPath: string
  readonly mode: number
  readonly sha256: string
  readonly bytes: number
  readonly action: "written" | "unchanged" | "restored" | "created"
}

export interface EstateSecretRow {
  readonly component: string
  readonly slot: string
  /** "present" = left byte-identical (R-262-2 never rotates a live secret); "created" = this run
   *  generated it; "refused" = present-but-invalid (empty / group-other bits), named in `code`. */
  readonly action: "present" | "created" | "refused"
  readonly mode: number
}

/** Closed refusal-code set from spec §4.1 — widen only through a controller ruling, never silently. */
export const DELIVER_CODES = [
  "DELIVER_SKIPPED_COMPONENT",
  "DELIVER_LEDGER_UNWRITABLE",
  "DELIVER_SECRET_INVALID",
  "DELIVER_TARGET_UNWRITABLE",
  "DELIVER_RENDER_REFUSED",
  "DELIVER_LINT_REFUSED",
  "DELIVER_WRITE_FAILED",
  "DELIVER_VERIFY_MISMATCH",
] as const
export type DeliverCode = (typeof DELIVER_CODES)[number]

export interface EstateDeliveryRecord {
  readonly ts: string // ISO-8601, same convention as provenance.ts
  readonly lockVersion: string // PC-LBL-03 source: tools.lock.json .version
  readonly program: { readonly name: string; readonly compiled: boolean; readonly entry: string }
  readonly stack: "searxng" | "firecrawl"
  readonly action: "attempt" | "delivered" | "unchanged" | "refused" | "rolled-back"
  readonly code?: DeliverCode
  readonly home: string
  readonly toolsRoot: string
  /** Absent on pre-render refusals (e.g. DELIVER_SKIPPED_COMPONENT): inventing a render block for
   *  a run that never rendered would break the same "never a fabricated 0" standard stacklib.ts:831-833
   *  holds for networksRemoved. */
  readonly render?: {
    readonly enginePath: string
    readonly caBundlePresent: boolean
    readonly lintErrorCount: number
  }
  readonly artefacts: ReadonlyArray<EstateArtefactRow>
  readonly secrets: ReadonlyArray<EstateSecretRow>
  /** R-262-3: files under the two component trees this render does not emit — reported, never pruned. */
  readonly residue: readonly string[]
  readonly elapsedMs: number
  readonly correlationId?: string // matches cmdInstall's `run-${process.pid}` (index.ts:315)
  /** Rolled-back runs only: the paths whose prior bytes were restored / whose creation was undone. */
  readonly rolledBack?: readonly string[]
}

export type EstateAppendOutcome = { ok: true; durable: boolean } | { ok: false; detail: string }

function syncPath(absPath: string): string | null {
  let fd: number
  try {
    fd = openSync(absPath, "r+")
  } catch (err) {
    return `open for fsync failed: ${(err as Error).message}`
  }
  try {
    fsyncSync(fd)
    return null
  } catch (err) {
    return `fsync failed: ${(err as Error).message}`
  } finally {
    try {
      closeSync(fd)
    } catch {
      // fd already gone; the sync result stands.
    }
  }
}

/** Append one record as a single JSONL line (dir 0700 / file 0600), then fsync — mirroring
 *  provenance.ts:110-116 including its loss rule: an fsync failure NEVER loses the line
 *  (appendFileSync already committed it to the page cache, kill-9-safe territory); the caller
 *  learns durability was not achieved instead of a throw unwinding a completed delivery. */
export function appendEstateDelivery(
  record: EstateDeliveryRecord,
  absPath: string = estateDeliveryFile(),
): EstateAppendOutcome {
  try {
    ensureParent(absPath)
    appendFileSync(absPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: MODES.FILE_0600 })
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
  const detail = syncPath(absPath)
  if (detail !== null) return { ok: true, durable: false }
  return { ok: true, durable: true }
}

/** Read the ledger back (proofs + tests). Missing file reads as an empty ledger; a malformed
 *  line surfaces as null so readers fail closed rather than silently skipping evidence. */
export function readEstateDeliveryRecords(absPath: string = estateDeliveryFile()): Array<EstateDeliveryRecord | null> {
  if (!existsSync(absPath)) return []
  return readFileSync(absPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as EstateDeliveryRecord
      } catch {
        return null
      }
    })
}

/** How the ledger describes whoever ran: the shipped detector decides `compiled`, NOT argv — a
 *  harness row can therefore never claim the product wrote the bytes (spec §5.3 discriminator D-B). */
export function programStamp(entryTokens: readonly string[]): EstateDeliveryRecord["program"] {
  return { name: PROGRAM_NAME, compiled: isCompiledBinary(), entry: `${PROGRAM_NAME} ${entryTokens.join(" ")}`.trim() }
}
