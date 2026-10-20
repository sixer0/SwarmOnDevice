// Provenance ledger (01c §6.1 evidence trail; P-1 "hash before any use" is only
// auditable if every fetch records what it expected and what it observed).
//
// One JSONL row per fetch ATTEMPT SEQUENCE — success, resume, or failure — at
// ~/.swarm/setup/provenance.jsonl (inside the P-16 whitelist, next to setup.log
// PC-PATH-05; dir 0700 / file 0600 by the register's mode classes). JSONL append
// of a single short line is effectively atomic on APFS and the lock directory
// (PC-PATH-04) already guarantees one writer at a time, so the atomic.ts
// tmp+rename dance is not needed for an append-only ledger.
//
// The record NEVER contains file content, never contains secrets (P-8), and is
// the artifact rows 108/111/112 re-verify against: url + version + expected/
// observed digest + size + timestamp + outcome.

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { MODES } from "./constants.ts"
import { ensureParent, setupRoot } from "./paths.ts"

export const PROVENANCE_FILE_NAME = "provenance.jsonl"

/** Where the ledger lives. Resolved lazily (paths.ts resolves $HOME per call) so
 *  a test can point HOME at a throwaway dir. Overridable via FetchOptions for
 *  callers that keep the ledger elsewhere inside the whitelist. */
export function provenanceFile(): string {
  return `${setupRoot()}/${PROVENANCE_FILE_NAME}`
}

export type ProvenanceOutcome = "fetched" | "resumed" | "dry_run" | "refused" | "failed"

export interface ProvenanceRecord {
  /** ISO-8601 wall-clock time of completion of the attempt sequence. */
  readonly ts: string
  /** tools.lock.json .version this fetch acted under (PC-LBL-03 source). */
  readonly lockVersion: string
  /** PC-CMP-* component id whose pin drove the fetch. */
  readonly component: string
  /** Lock field/artifact key within the component (e.g. "node", "colima"). */
  readonly artifact: string
  /** Final URL actually fetched (after any allow-listed redirects). */
  readonly url: string
  /** Version as pinned in the lock. */
  readonly version?: string
  /** Expected hash exactly as written in the lock (hex or npm integrity form). */
  readonly expected: string
  /** Observed digest of the bytes that were downloaded (lowercase hex), if any. */
  readonly observed?: string
  /** Bytes expected per the lock pin, when pinned. */
  readonly expectedSizeBytes?: number
  /** Bytes actually written to the temp file, when a body was streamed. */
  readonly downloadedBytes?: number
  readonly outcome: ProvenanceOutcome
  /** Machine-readable reason for refused/failed outcomes (FetchCode value). */
  readonly code?: string
  /** Network attempts consumed (1 = first try succeeded; 2 = one backoff retry). */
  readonly attempts: number
  /** Wall-clock duration of the attempt sequence, ms. */
  readonly elapsedMs?: number
  /** Absolute path of the verified final file (success/resume only). */
  readonly destPath?: string
}

/** Append one record as a single JSONL line (mode 0600 on create, 0700 parent). */
export function appendProvenance(record: ProvenanceRecord, absPath: string = provenanceFile()): void {
  ensureParent(absPath)
  appendFileSync(absPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: MODES.FILE_0600 })
}

/** Read the ledger back (rows 108/111/112 re-verification + tests). Missing file
 *  reads as an empty ledger; a malformed line surfaces as null so readers can
 *  fail closed rather than silently skip evidence. */
export function readProvenanceRecords(absPath: string = provenanceFile()): Array<ProvenanceRecord | null> {
  if (!existsSync(absPath)) return []
  return readFileSync(absPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as ProvenanceRecord
      } catch {
        return null
      }
    })
}
